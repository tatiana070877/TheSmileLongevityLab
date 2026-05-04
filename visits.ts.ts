"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth/session";
import { module1VisitSchema, module2VisitSchema } from "@/lib/validations/visits";
import {
  aggregateObas,
  calculateChronologicalAge,
  calculateGap,
  calculateModule1Scores,
  calculateModule2Scores,
  calculateOralBiologicalAge,
  generatePatientHeadline,
  getAgeNorm,
  type ChewingDifficulty,
  type HpvStatus,
  type MucosalExam,
  type NitricOxideStrip,
  type SmokerStatus,
} from "@/lib/scoring/obas";
import { generateRecommendations } from "@/lib/scoring/recommendations";
import {
  generateReferralFlags,
  type ReferralContextModule1,
  type ReferralContextModule2,
} from "@/lib/scoring/referrals";
import { generateClinicalNarrative, type NarrativeContext } from "@/lib/ai/claudeNarrative";

async function persistAiNarratives(visitId: string, ctx: NarrativeContext) {
  const supabase = await createClient();
  try {
    const [en, he] = await Promise.allSettled([
      generateClinicalNarrative(ctx, "en"),
      generateClinicalNarrative(ctx, "he"),
    ]);
    const enValue = en.status === "fulfilled" ? en.value : null;
    const heValue = he.status === "fulfilled" ? he.value : null;
    await supabase
      .from("visits")
      .update({
        ai_narrative_en: enValue ? JSON.stringify(enValue) : null,
        ai_narrative_he: heValue ? JSON.stringify(heValue) : null,
        ai_generated_at: new Date().toISOString(),
      })
      .eq("id", visitId);
  } catch {
    // Never block visit creation on AI errors.
  }
}

async function previousVisitSummary(patientId: string, beforeDate: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("visits")
    .select("id, visit_date, obas_score, oral_biological_age")
    .eq("patient_id", patientId)
    .lt("visit_date", beforeDate)
    .order("visit_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function createModule1Visit(
  patientId: string,
  formData: unknown,
): Promise<{ error: string } | { visitId: string }> {
  const session = await getSessionProfile();
  if (!session || (session.profile.role !== "doctor" && session.profile.role !== "admin")) {
    return { error: "Unauthorized" };
  }

  const parsed = module1VisitSchema.safeParse(formData);
  if (!parsed.success) {
    return { error: "Validation failed. Please review highlighted fields." };
  }
  const v = parsed.data;
  const supabase = await createClient();

  const { data: patient, error: pErr } = await supabase
    .from("patients")
    .select("*")
    .eq("id", patientId)
    .single();
  if (pErr || !patient) return { error: "Patient not found" };

  const chrono = calculateChronologicalAge(patient.date_of_birth, v.visitDate);
  const { norm, outsideValidatedRange } = getAgeNorm(chrono);

  const domains = calculateModule1Scores({
    bopPercent: v.bopPercent,
    avgPocketDepthMm: v.avgPocketDepthMm,
    mmp8NgMl: v.mmp8NgMl,
    salivaryPh: v.salivaryPh,
    noStrip: v.noStrip as NitricOxideStrip,
    naturalTeeth: v.naturalTeeth,
    implantSites: v.implantSites,
    unreplacedMissing: v.unreplacedMissing,
    mucosalExam: v.mucosalExam as MucosalExam,
  });

  const obas = aggregateObas(domains);
  const gap = calculateGap(obas, norm);
  const oralBio = calculateOralBiologicalAge(chrono, gap);

  const smoker = patient.smoker_status as SmokerStatus;
  const smokerWarning = smoker === "yes";

  const prev = await previousVisitSummary(patientId, v.visitDate);
  const headline = generatePatientHeadline(chrono, oralBio, obas, {
    previousOralBioAge: prev?.oral_biological_age ?? null,
    previousObas: prev?.obas_score ?? null,
  });

  const referralCtx: ReferralContextModule1 = {
    module: "module_1",
    smokerStatus: smoker,
    bopPercent: v.bopPercent,
    avgPocketDepthMm: v.avgPocketDepthMm,
    mmp8NgMl: v.mmp8NgMl,
    hsCrp: v.hsCrp,
    hba1c: v.hba1c,
    salivaryPh: v.salivaryPh,
    noStrip: v.noStrip as NitricOxideStrip,
    unreplacedMissing: v.unreplacedMissing,
    mucosalExam: v.mucosalExam as MucosalExam,
    chewingDifficulty: v.chewingDifficulty as ChewingDifficulty,
    hpvStatus: v.hpvStatus as HpvStatus,
    acidErosionConcern: v.acidErosionConcern,
  };

  const referrals = generateReferralFlags(referralCtx);
  const recs = generateRecommendations(domains, referrals, {
    activeSmoker: smoker === "yes",
    markers: { salivaryPh: v.salivaryPh, noStrip: v.noStrip as NitricOxideStrip },
  });

  const { data: visit, error: vErr } = await supabase
    .from("visits")
    .insert({
      patient_id: patientId,
      doctor_id: session.userId,
      module_type: "module_1",
      visit_date: v.visitDate,
      practitioner: v.practitioner,
      chronological_age: chrono,
      age_norm: norm,
      obas_score: obas,
      oral_biological_age: oralBio,
      gap_from_norm: gap,
      headline,
      notes: v.notes ?? null,
      outside_norm_range: outsideValidatedRange,
      smoker_clinical_warning: smokerWarning,
    })
    .select("id")
    .single();

  if (vErr || !visit) return { error: vErr?.message ?? "Visit insert failed" };

  const visitId = visit.id as string;

  const domainRows = domains.map((d) => ({
    visit_id: visitId,
    domain_key: d.domainKey,
    domain_name: d.domainName,
    score: d.score,
    weight: d.weight,
    status: d.status,
    details: d.details ?? null,
  }));
  await supabase.from("domain_scores").insert(domainRows);

  const biomarkers: {
    visit_id: string;
    marker_key: string;
    marker_name: string;
    value_text?: string | null;
    value_number?: number | null;
    unit?: string | null;
  }[] = [
    { visit_id: visitId, marker_key: "hba1c", marker_name: "HbA1c", value_number: v.hba1c ?? null, unit: "%" },
    { visit_id: visitId, marker_key: "hscrp", marker_name: "hsCRP", value_number: v.hsCrp ?? null, unit: "mg/L" },
    {
      visit_id: visitId,
      marker_key: "vitamin_d3",
      marker_name: "Vitamin D3",
      value_number: v.vitaminD3 ?? null,
      unit: "ng/mL",
    },
    { visit_id: visitId, marker_key: "chewing_difficulty", marker_name: "Chewing difficulty", value_text: v.chewingDifficulty },
    { visit_id: visitId, marker_key: "hpv_status", marker_name: "HPV vaccination status", value_text: v.hpvStatus },
    { visit_id: visitId, marker_key: "mouthwash", marker_name: "Antiseptic mouthwash", value_text: v.mouthwashUse },
    { visit_id: visitId, marker_key: "bop_percent", marker_name: "BOP %", value_number: v.bopPercent, unit: "%" },
    {
      visit_id: visitId,
      marker_key: "avg_pocket_mm",
      marker_name: "Average pocket depth",
      value_number: v.avgPocketDepthMm,
      unit: "mm",
    },
    { visit_id: visitId, marker_key: "mmp8_ng_ml", marker_name: "MMP-8", value_number: v.mmp8NgMl, unit: "ng/ml" },
    { visit_id: visitId, marker_key: "salivary_ph", marker_name: "Salivary pH", value_number: v.salivaryPh },
    { visit_id: visitId, marker_key: "no_strip", marker_name: "Nitric oxide strip", value_text: v.noStrip },
    { visit_id: visitId, marker_key: "natural_teeth", marker_name: "Natural teeth", value_number: v.naturalTeeth },
    { visit_id: visitId, marker_key: "implant_sites", marker_name: "Implant-restored sites", value_number: v.implantSites },
    {
      visit_id: visitId,
      marker_key: "unreplaced_missing",
      marker_name: "Unreplaced missing sites",
      value_number: v.unreplacedMissing,
    },
    { visit_id: visitId, marker_key: "mucosal_exam", marker_name: "Mucosal exam", value_text: v.mucosalExam },
  ];
  await supabase.from("biomarker_results").insert(biomarkers);

  await supabase.from("referral_flags").insert(
    referrals.map((r) => ({
      visit_id: visitId,
      severity: r.severity,
      specialist: r.specialist,
      reason: r.reason,
    })),
  );

  await supabase.from("recommendations").insert(
    recs.map((r) => ({
      visit_id: visitId,
      priority: r.priority,
      domain_key: r.domainKey,
      recommendation_text: r.recommendationText,
      duration: r.duration ?? null,
    })),
  );

  await persistAiNarratives(visitId, {
    patient: {
      firstName: patient.first_name,
      lastName: patient.last_name,
      dateOfBirth: patient.date_of_birth,
      gender: patient.gender,
      smokerStatus: patient.smoker_status,
    },
    visit: {
      moduleType: "module_1",
      visitDate: v.visitDate,
      chronologicalAge: chrono,
      ageNorm: norm,
      obasScore: obas,
      oralBiologicalAge: oralBio,
      gapFromNorm: gap,
      headline,
      outsideNormRange: outsideValidatedRange,
      smokerClinicalWarning: smokerWarning,
    },
    domains: domains.map((d) => ({
      domainKey: d.domainKey,
      domainName: d.domainName,
      score: d.score,
      weight: d.weight,
      status: d.status,
      details: d.details ?? null,
    })),
    biomarkers: biomarkers.map((b) => ({
      markerKey: b.marker_key,
      markerName: b.marker_name,
      valueText: b.value_text ?? null,
      valueNumber: b.value_number ?? null,
      unit: b.unit ?? null,
    })),
    referrals: referrals.map((r) => ({
      severity: r.severity,
      specialist: r.specialist,
      reason: r.reason,
    })),
    recommendations: recs.map((r) => ({
      priority: r.priority,
      text: r.recommendationText,
      duration: r.duration ?? null,
    })),
  });

  revalidatePath(`/doctor/patients/${patientId}`);
  return { visitId };
}

export async function createModule2Visit(
  patientId: string,
  formData: unknown,
): Promise<{ error: string } | { visitId: string }> {
  const session = await getSessionProfile();
  if (!session || (session.profile.role !== "doctor" && session.profile.role !== "admin")) {
    return { error: "Unauthorized" };
  }

  const parsed = module2VisitSchema.safeParse(formData);
  if (!parsed.success) {
    return { error: "Validation failed. Please review highlighted fields." };
  }
  const v = parsed.data;
  const supabase = await createClient();

  const { data: patient, error: pErr } = await supabase
    .from("patients")
    .select("*")
    .eq("id", patientId)
    .single();
  if (pErr || !patient) return { error: "Patient not found" };

  const chrono = calculateChronologicalAge(patient.date_of_birth, v.visitDate);
  const { norm, outsideValidatedRange } = getAgeNorm(chrono);

  const domains = calculateModule2Scores({
    bopPercent: v.bopPercent,
    avgPocketDepthMm: v.avgPocketDepthMm,
    mmp8: v.mmp8Category,
    bristleScore: v.bristleScore,
    noStrip: v.noStrip as NitricOxideStrip,
    pGingivalis: v.pGingivalis,
    fusobacterium: v.fusobacterium,
    scanWear: v.scanWear,
    opg: v.opg,
    periapicalPathology: v.periapicalPathology,
    tmj: v.tmj as 0 | 1 | 2,
    naturalTeeth: v.naturalTeeth,
    implantSites: v.implantSites,
    unreplacedMissing: v.unreplacedMissing,
    velscope: v.velscope as MucosalExam,
  });

  const obas = aggregateObas(domains);
  const gap = calculateGap(obas, norm);
  const oralBio = calculateOralBiologicalAge(chrono, gap);
  const smoker = patient.smoker_status as SmokerStatus;
  const smokerWarning = smoker === "yes";

  const prev = await previousVisitSummary(patientId, v.visitDate);
  const headline = generatePatientHeadline(chrono, oralBio, obas, {
    previousOralBioAge: prev?.oral_biological_age ?? null,
    previousObas: prev?.obas_score ?? null,
  });

  const referralCtx: ReferralContextModule2 = {
    module: "module_2",
    smokerStatus: smoker,
    bopPercent: v.bopPercent,
    avgPocketDepthMm: v.avgPocketDepthMm,
    mmp8Category: v.mmp8Category,
    hsCrp: v.hsCrp,
    hba1c: v.hba1c,
    bristleScore: v.bristleScore,
    pGingivalis: v.pGingivalis,
    fusobacterium: v.fusobacterium,
    scanWear: v.scanWear,
    opg: v.opg,
    periapicalPathology: v.periapicalPathology,
    generalizedBoneLoss: v.generalizedBoneLoss ?? false,
    tmj: v.tmj as 0 | 1 | 2,
    stopBang: v.stopBang,
    velscope: v.velscope as MucosalExam,
    unreplacedMissing: v.unreplacedMissing,
    toothLossRate: v.toothLossRate,
    mouthBreathing: v.mouthBreathing,
    clinicalAirwayFinding: v.clinicalAirwayFinding ?? false,
  };

  const referrals = generateReferralFlags(referralCtx);
  const recs = generateRecommendations(domains, referrals, {
    activeSmoker: smoker === "yes",
    markers: { noStrip: v.noStrip as NitricOxideStrip },
  });

  const { data: visit, error: vErr } = await supabase
    .from("visits")
    .insert({
      patient_id: patientId,
      doctor_id: session.userId,
      module_type: "module_2",
      visit_date: v.visitDate,
      practitioner: v.practitioner,
      chronological_age: chrono,
      age_norm: norm,
      obas_score: obas,
      oral_biological_age: oralBio,
      gap_from_norm: gap,
      headline,
      notes: v.notes ?? null,
      outside_norm_range: outsideValidatedRange,
      smoker_clinical_warning: smokerWarning,
    })
    .select("id")
    .single();

  if (vErr || !visit) return { error: vErr?.message ?? "Visit insert failed" };

  const visitId = visit.id as string;

  await supabase.from("domain_scores").insert(
    domains.map((d) => ({
      visit_id: visitId,
      domain_key: d.domainKey,
      domain_name: d.domainName,
      score: d.score,
      weight: d.weight,
      status: d.status,
      details: d.details ?? null,
    })),
  );

  const biomarkers = [
    { visit_id: visitId, marker_key: "hba1c", marker_name: "HbA1c", value_number: v.hba1c ?? null, unit: "%" },
    { visit_id: visitId, marker_key: "hscrp", marker_name: "hsCRP", value_number: v.hsCrp ?? null, unit: "mg/L" },
    {
      visit_id: visitId,
      marker_key: "vitamin_d3",
      marker_name: "Vitamin D3",
      value_number: v.vitaminD3 ?? null,
      unit: "ng/mL",
    },
    { visit_id: visitId, marker_key: "stop_bang", marker_name: "STOP-BANG", value_number: v.stopBang },
    { visit_id: visitId, marker_key: "chewing_difficulty", marker_name: "Chewing difficulty", value_text: v.chewingDifficulty },
    { visit_id: visitId, marker_key: "mouth_breathing", marker_name: "Mouth breathing", value_text: String(v.mouthBreathing) },
    { visit_id: visitId, marker_key: "tongue_coating", marker_name: "Tongue coating score", value_number: v.tongueCoating },
    { visit_id: visitId, marker_key: "hpv_status", marker_name: "HPV vaccination status", value_text: v.hpvStatus },
    { visit_id: visitId, marker_key: "mouthwash", marker_name: "Antiseptic mouthwash", value_text: v.mouthwashUse },
    { visit_id: visitId, marker_key: "bop_percent", marker_name: "BOP %", value_number: v.bopPercent, unit: "%" },
    {
      visit_id: visitId,
      marker_key: "avg_pocket_mm",
      marker_name: "Average pocket depth",
      value_number: v.avgPocketDepthMm,
      unit: "mm",
    },
    {
      visit_id: visitId,
      marker_key: "attachment_notes",
      marker_name: "Attachment / recession notes",
      value_text: v.attachmentNotes ?? "",
    },
    { visit_id: visitId, marker_key: "mmp8_category", marker_name: "MMP-8 status", value_text: v.mmp8Category },
    { visit_id: visitId, marker_key: "bristle_score", marker_name: "Bristle Health score", value_number: v.bristleScore },
    { visit_id: visitId, marker_key: "p_gingivalis", marker_name: "P. gingivalis", value_text: String(v.pGingivalis) },
    { visit_id: visitId, marker_key: "fusobacterium", marker_name: "Fusobacterium", value_text: String(v.fusobacterium) },
    { visit_id: visitId, marker_key: "no_strip", marker_name: "Nitric oxide strip", value_text: v.noStrip },
    { visit_id: visitId, marker_key: "scan_wear", marker_name: "Intraoral scan wear", value_text: v.scanWear },
    { visit_id: visitId, marker_key: "opg", marker_name: "OPG bone/pathology", value_text: v.opg },
    {
      visit_id: visitId,
      marker_key: "periapical_pathology",
      marker_name: "Periapical pathology",
      value_text: String(v.periapicalPathology),
    },
    { visit_id: visitId, marker_key: "tmj", marker_name: "TMJ / bruxism score", value_number: v.tmj },
    { visit_id: visitId, marker_key: "mouth_opening_mm", marker_name: "Mouth opening", value_number: v.mouthOpeningMm ?? null, unit: "mm" },
    { visit_id: visitId, marker_key: "natural_teeth", marker_name: "Natural teeth", value_number: v.naturalTeeth },
    { visit_id: visitId, marker_key: "implant_sites", marker_name: "Implant-restored sites", value_number: v.implantSites },
    {
      visit_id: visitId,
      marker_key: "unreplaced_missing",
      marker_name: "Unreplaced missing sites",
      value_number: v.unreplacedMissing,
    },
    {
      visit_id: visitId,
      marker_key: "tooth_loss_rate",
      marker_name: "Tooth loss rate since last record",
      value_number: v.toothLossRate ?? null,
    },
    { visit_id: visitId, marker_key: "velscope", marker_name: "VELscope", value_text: v.velscope },
    { visit_id: visitId, marker_key: "mucosal_notes", marker_name: "Visual mucosal notes", value_text: v.mucosalNotes ?? "" },
  ];
  await supabase.from("biomarker_results").insert(biomarkers);

  await supabase.from("referral_flags").insert(
    referrals.map((r) => ({
      visit_id: visitId,
      severity: r.severity,
      specialist: r.specialist,
      reason: r.reason,
    })),
  );

  await supabase.from("recommendations").insert(
    recs.map((r) => ({
      visit_id: visitId,
      priority: r.priority,
      domain_key: r.domainKey,
      recommendation_text: r.recommendationText,
      duration: r.duration ?? null,
    })),
  );

  await persistAiNarratives(visitId, {
    patient: {
      firstName: patient.first_name,
      lastName: patient.last_name,
      dateOfBirth: patient.date_of_birth,
      gender: patient.gender,
      smokerStatus: patient.smoker_status,
    },
    visit: {
      moduleType: "module_2",
      visitDate: v.visitDate,
      chronologicalAge: chrono,
      ageNorm: norm,
      obasScore: obas,
      oralBiologicalAge: oralBio,
      gapFromNorm: gap,
      headline,
      outsideNormRange: outsideValidatedRange,
      smokerClinicalWarning: smokerWarning,
    },
    domains: domains.map((d) => ({
      domainKey: d.domainKey,
      domainName: d.domainName,
      score: d.score,
      weight: d.weight,
      status: d.status,
      details: d.details ?? null,
    })),
    biomarkers: biomarkers.map((b) => ({
      markerKey: b.marker_key,
      markerName: b.marker_name,
      valueText: ("value_text" in b ? b.value_text : null) ?? null,
      valueNumber: ("value_number" in b ? b.value_number : null) ?? null,
      unit: ("unit" in b ? (b as { unit?: string | null }).unit : null) ?? null,
    })),
    referrals: referrals.map((r) => ({
      severity: r.severity,
      specialist: r.specialist,
      reason: r.reason,
    })),
    recommendations: recs.map((r) => ({
      priority: r.priority,
      text: r.recommendationText,
      duration: r.duration ?? null,
    })),
  });

  revalidatePath(`/doctor/patients/${patientId}`);
  return { visitId };
}
