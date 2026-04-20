import { actorConditionMap, targetConditionMap } from "./constants.js";
import { distanceBetween, getSetting } from "./utils.js";
import { applyEffectRules } from "./effectRules.js";

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

async function applyVisionAdapters(context) {
  for (const adapter of getVisionAdapters()) {
    await adapter?.(context);
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

function isRelevantConditionSlug(slug, conditionMap, checkingAttacker, isSpell) {
  if (checkingAttacker && isSpell && slug === "stupefied") return true;
  return Object.prototype.hasOwnProperty.call(conditionMap, slug);
}

function getActorConditionItems(actor) {
  const items = [];
  if (Array.isArray(actor?.itemTypes?.condition)) items.push(...actor.itemTypes.condition);
  if (Array.isArray(actor?.conditions?.active)) items.push(...actor.conditions.active);
  const bySlug = actor?.conditions?.bySlug;
  if (bySlug && typeof bySlug === "object") {
    const values = typeof bySlug.values === "function" ? Array.from(bySlug.values()) : Object.values(bySlug);
    for (const condition of values) {
      if (condition?.active) items.push(condition);
    }
  }
  return items;
}

function getConditionValue(condition) {
  if (typeof condition?.value === "number") return condition.value;
  const systemValue = condition?.system?.value;
  if (typeof systemValue === "number") return systemValue;
  if (typeof systemValue?.value === "number") return systemValue.value;
  return undefined;
}

function addRollOptionConditions(conditionSet, rollOptions, conditionMap, checkingAttacker, isSpell) {
  if (!Array.isArray(rollOptions)) return;
  for (const option of rollOptions) {
    if (typeof option !== "string") continue;
    const splitIndex = option.indexOf(":condition:");
    if (splitIndex === -1) continue;
    const targetPrefix = option.slice(0, splitIndex);
    const slug = option.slice(splitIndex + ":condition:".length);
    if (!slug) continue;
    if (checkingAttacker && !["self", "attacker"].includes(targetPrefix)) continue;
    if (!checkingAttacker && targetPrefix !== "target") continue;
    if (isRelevantConditionSlug(slug, conditionMap, checkingAttacker, isSpell)) {
      conditionSet.add(slug);
    }
  }
}

async function gatherConditions(token, target, isSpell, conditionMap, checkingAttacker, info, rollOptions) {
  const currentActor = checkingAttacker ? token?.actor : target?.actor;
  if (!currentActor) return { conditions: [], stupefyLevel: undefined };

  const conditionItems = getActorConditionItems(currentActor);
  const conditionSet = new Set();
  for (const condition of conditionItems) {
    const slug = condition?.slug;
    if (!slug) continue;
    if (isRelevantConditionSlug(slug, conditionMap, checkingAttacker, isSpell)) {
      conditionSet.add(slug);
    }
  }

  addRollOptionConditions(conditionSet, rollOptions, conditionMap, checkingAttacker, isSpell);

  if (checkingAttacker && info.grabbed) conditionSet.add("grabbed");
  if (!checkingAttacker && info.blinded) conditionSet.add("hidden");
  if (!checkingAttacker && info.dazzled) conditionSet.add("concealed");

  await applyVisionAdapters({
    token,
    target,
    isSpell,
    checkingAttacker,
    info,
    actor: currentActor,
    conditionMap,
    conditionSet,
  });

  applyEffectRules(conditionSet, token, target);

  const conditions = Array.from(conditionSet).sort();

  let stupefyLevel;
  if (conditions.includes("stupefied")) {
    stupefyLevel = getConditionValue(conditionItems.find((c) => c.slug === "stupefied"));
    if (stupefyLevel) conditionMap["stupefied"] = stupefyLevel + 5;
  }

  return { conditions, stupefyLevel };
}

function determineCondition(conditionList, stupefyLevel, conditionMap, info, checkingAttacker, traits) {
  if (!conditionList) return {};

  let relevantConditions = conditionList;
  if (checkingAttacker && !traits?.includes("manipulate")) {
    relevantConditions = conditionList.filter((condition) => condition !== "grabbed");
  }

  if (relevantConditions.length === 0) return {};

  let baseCondition = relevantConditions.reduce((acc, curr) => {
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
    ((conditionName === "Hidden" || conditionName === "Invisible" || conditionName === "Undetected") &&
      (ignoreInvisibility || areaAttack)) ||
    (conditionName === "Grabbed" && ignoreGrabbed)
  );
}

export async function getCondition(token, target, isSpell, traits, areaAttack, rollOptions) {
  const ignoreConcealed = getSetting("ignoreConcealed");
  const ignoreGrabbed = getSetting("ignoreGrabbed");
  const ignoreInvisibility = getSetting("ignoreInvisibility");

  const checkingAttacker = target === null;
  const conditionMap = checkingAttacker ? { ...actorConditionMap } : targetConditionMap;
  const info = getAttackerInfo(token, target);

  const { conditions, stupefyLevel } = await gatherConditions(
    token,
    target,
    isSpell,
    conditionMap,
    checkingAttacker,
    info,
    rollOptions
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
  if (!actor) return;
  const attackerSenses = token?.actor?.system?.traits?.senses;
  if (!Array.isArray(attackerSenses)) return;

  const attackerLowLightVision = attackerSenses.some((s) => s.type === "lowLightVision");
  const targetInDimLight = actor.getFlag("pf2e-darkness-effects", "darknessLevel") === 1;
  if (targetInDimLight && !attackerLowLightVision) {
    conditionSet.add("concealed");
  }

  const attackerDarkvision = attackerSenses.some((s) => s.type === "darkvision");
  const targetInDarkness = actor.getFlag("pf2e-darkness-effects", "darknessLevel") === 0;
  if (targetInDarkness && !attackerDarkvision) {
    conditionSet.add("hidden");
  }
}

function getGameSetting(namespace, key, fallback = null) {
  const fullKey = `${namespace}.${key}`;
  if (game.settings?.settings?.has(fullKey)) {
    try {
      return game.settings.get(namespace, key);
    } catch (error) {
      return fallback;
    }
  }
  return fallback;
}

function normalizeVisionerVisibility(visibility) {
  if (Array.isArray(visibility)) {
    visibility =
      visibility.find((entry) => typeof entry === "string" && entry.length > 0) ??
      visibility[0] ??
      null;
  }

  if (typeof visibility !== "string") return null;
  return visibility.toLowerCase();
}

async function getPf2eVisionerVisibility(api, observerToken, targetToken) {
  if (!observerToken || !targetToken) return null;

  const manualVisibility = normalizeVisionerVisibility(
    api?.getVisibility?.(observerToken.id, targetToken.id) ??
    api?.getVisibility?.(observerToken, targetToken) ??
    api?.getVisibilityBetween?.(observerToken, targetToken) ??
    window.visioneerApi?.getVisibility?.(observerToken.id, targetToken.id) ??
    window.visioneerApi?.getVisibility?.(observerToken, targetToken) ??
    null
  );

  if (manualVisibility && !["observed", "avs"].includes(manualVisibility)) {
    return manualVisibility;
  }

  if (!getGameSetting("pf2e-visioner", "autoVisibilityEnabled", false)) {
    return manualVisibility === "avs" ? null : manualVisibility;
  }

  const autoVisibilitySystem = window.pf2eVisioner?.services?.autoVisibilitySystem;
  if (typeof autoVisibilitySystem?.calculateVisibilityWithOverrides === "function") {
    try {
      const visibility = normalizeVisionerVisibility(
        await autoVisibilitySystem.calculateVisibilityWithOverrides(observerToken, targetToken)
      );
      if (visibility) return visibility;
    } catch {
    }
  }

  if (typeof api?.autoVisibility?.calculateVisibility === "function") {
    try {
      const visibility = normalizeVisionerVisibility(
        await api.autoVisibility.calculateVisibility(observerToken, targetToken)
      );
      if (visibility) return visibility;
    } catch {
    }
  }

  return manualVisibility === "avs" ? null : manualVisibility;
}

async function pf2eVisionerAdapter(context) {
  const module = getPf2eVisionerModule();
  if (!module?.active) return;
  if (context.checkingAttacker || !context.target || !context.token) return;

  const api = module.api;
  const visibility = await getPf2eVisionerVisibility(api, context.token, context.target);

  if (visibility === "concealed" || visibility === "hidden" || visibility === "undetected") {
    context.conditionSet.add(visibility);
  }

  api?.applyFlatCheckAdjustments?.(context);
}
