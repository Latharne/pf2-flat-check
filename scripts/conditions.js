import { actorConditionMap, targetConditionMap } from "./constants.js";
import { distanceBetween, getSetting } from "./utils.js";

function getPf2eVisionerModule() {
  return game.modules.get("pf2e-visioner") ?? game.modules.get("pf2evisioner");
}

function shouldUsePf2eVisionerAdapter() {
  if (!getPf2eVisionerModule()?.active) return false;
  try {
    return getSetting("usePf2eVisionerAdapter");
  } catch (error) {
    return true;
  }
}

function getVisionAdapters() {
  const adapters = [pf2eDarknessAdapter];
  if (shouldUsePf2eVisionerAdapter()) adapters.push(pf2eVisionerAdapter);
  return adapters;
}

function applyVisionAdapters(context) {
  for (const adapter of getVisionAdapters()) {
    adapter?.(context);
  }
}

function getAttackerInfo(token, target) {
  const attacker = token?.actor;
  const info = {
    blinded: !!attacker?.items?.find((i) => i.slug === "blinded"),
    dazzled: !!attacker?.items?.find((i) => i.slug === "dazzled"),
    blindFight: !!attacker?.items?.find((i) => i.slug === "blind-fight"),
    liminalFetchling: !!attacker?.items?.find(
      (i) =>
        i.slug === "liminal-fetchling" ||
        i.system?.slug === "liminal-fetchling" ||
        i.slug === "laminal-fetchling" ||
        i.system?.slug === "laminal-fetchling"
    ),
    hasMothSupportEffect: !!attacker?.items.some(
      (i) => i.type === "effect" && i.name === "Effect: Moth Support Benefit"
    ),
    keenEyes: !!attacker?.items?.find((i) => i.slug === "keen-eyes"),
    grabbed: !!attacker?.items?.find((i) => i.slug === "grabbed"),
    adjacent: target ? distanceBetween(token, target) <= 5 : false,
    equalOrHigherLevel: target
      ? (attacker?.level || -Infinity) >= (target?.actor?.level || Infinity)
      : false,
  };
  return info;
}

function gatherConditions(token, target, isSpell, conditionMap, checkingAttacker, info) {
  const currentActor = checkingAttacker ? token.actor : target.actor;

  const conditionSet = new Set(
    currentActor.itemTypes.condition
      .filter((c) => {
        if (checkingAttacker && isSpell && c.slug === "stupefied") return true;
        return Object.keys(conditionMap).includes(c.slug);
      })
      .map((c) => c.slug)
  );

  if (checkingAttacker && info.grabbed) conditionSet.add("grabbed");
  if (!checkingAttacker && info.blinded) conditionSet.add("hidden");
  if (!checkingAttacker && info.dazzled) conditionSet.add("concealed");

  applyVisionAdapters({
    token,
    target,
    isSpell,
    checkingAttacker,
    info,
    actor: currentActor,
    conditionMap,
    conditionSet,
  });

  const conditions = Array.from(conditionSet).sort();

  let stupefyLevel;
  if (conditions.includes("stupefied")) {
    stupefyLevel = currentActor.itemTypes.condition.find((c) => c.slug === "stupefied")?.value;
    if (stupefyLevel) conditionMap["stupefied"] = stupefyLevel + 5;
  }

  return { conditions, stupefyLevel };
}

function determineCondition(conditionList, stupefyLevel, conditionMap, info, checkingAttacker, traits) {
  if (!conditionList || conditionList.length === 0) return {};

  let baseCondition = conditionList.reduce((acc, curr) => {
    const accDC = conditionMap[acc] ?? -Infinity;
    const currDC = conditionMap[curr] ?? -Infinity;
    return accDC >= currDC ? acc : curr;
  });

  let logicalCondition = baseCondition;
  if (logicalCondition === "invisible" || baseCondition === "undetected") {
    logicalCondition = "hidden";
  }
  let DC = conditionMap[logicalCondition];

  if (baseCondition === "stupefied" && typeof stupefyLevel === "number") {
    DC = stupefyLevel + 5;
  }

  if (checkingAttacker && info.blindFight && baseCondition === "dazzled") return {};

  if (!checkingAttacker) {
    if (info.liminalFetchling || info.keenEyes || info.hasMothSupportEffect) {
      if (logicalCondition === "concealed") DC = 3;
      if (logicalCondition === "hidden") DC = 9;
    }

    if (info.blindFight) {
      if (baseCondition === "concealed") return {};
      if (baseCondition === "hidden") DC = 5;
      if ((baseCondition === "invisible" || baseCondition === "undetected") && info.adjacent && info.equalOrHigherLevel) {
        baseCondition = "hidden";
        DC = 5;
      }
    }
  }

  if (checkingAttacker && info.grabbed && traits?.includes("manipulate")) {
    if (5 > DC || DC === undefined) {
      baseCondition = "grabbed";
      DC = 5;
    }
  }

  if (DC === -Infinity) return {};

  return { condition: baseCondition, DC };
}

function shouldIgnoreCondition(conditionName, areaAttack, ignoreConcealed, ignoreInvisibility, ignoreGrabbed) {
  return (
    ((conditionName === "Concealed" || conditionName === "Dazzled") &&
      (ignoreConcealed || areaAttack)) ||
    ((conditionName === "Hidden" || conditionName === "Invisible") &&
      (ignoreInvisibility || areaAttack)) ||
    (conditionName === "Grabbed" && ignoreGrabbed)
  );
}

export function getCondition(token, target, isSpell, traits, areaAttack) {
  const ignoreConcealed = getSetting("ignoreConcealed");
  const ignoreGrabbed = getSetting("ignoreGrabbed");
  const ignoreInvisibility = getSetting("ignoreInvisibility");

  const checkingAttacker = target === null;
  const conditionMap = checkingAttacker ? { ...actorConditionMap } : targetConditionMap;
  const info = getAttackerInfo(token, target);

  const { conditions, stupefyLevel } = gatherConditions(
    token,
    target,
    isSpell,
    conditionMap,
    checkingAttacker,
    info
  );

  const { condition, DC } = determineCondition(
    conditions,
    stupefyLevel,
    conditionMap,
    info,
    checkingAttacker,
    traits
  );

  const conditionName =
    condition && condition.length > 0 ? condition.charAt(0).toUpperCase() + condition.slice(1) : condition;

  if (shouldIgnoreCondition(conditionName, areaAttack, ignoreConcealed, ignoreInvisibility, ignoreGrabbed)) {
    return {};
  }
  return { conditionName, DC };
}

function pf2eDarknessAdapter({ token, actor, checkingAttacker, conditionSet }) {
  if (checkingAttacker) return;
  if (!game.modules.get("pf2e-darkness-effects")?.active) return;

  const attackerLowLightVision = token.actor.system.traits.senses.some((s) => s.type === "lowLightVision");
  const targetInDimLight = actor.getFlag("pf2e-darkness-effects", "darknessLevel") === 1;
  if (targetInDimLight && !attackerLowLightVision) {
    conditionSet.add("concealed");
  }

  const attackerDarkvision = token.actor.system.traits.senses.some((s) => s.type === "darkvision");
  const targetInDarkness = actor.getFlag("pf2e-darkness-effects", "darknessLevel") === 0;
  if (targetInDarkness && !attackerDarkvision) {
    conditionSet.add("hidden");
  }
}

function pf2eVisionerAdapter(context) {
  const module = getPf2eVisionerModule();
  if (!module?.active) return;
  if (context.checkingAttacker || !context.target || !context.token) return;

  const api = module.api;
  const observerTokenID = context.token.id;
  const targetTokenID = context.target.id;

  const visibility =
    observerTokenID && targetTokenID
      ? api?.getVisibility?.(observerTokenID, targetTokenID)
      : null;

  if (visibility === "concealed" || visibility === "hidden" || visibility === "undetected") {
    context.conditionSet.add(visibility);
  }

  api?.applyFlatCheckAdjustments?.(context);
}
