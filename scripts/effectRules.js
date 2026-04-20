/**
 * Effect Rules System
 *
 * Two subsystems that run before DC determination:
 *
 * 1. Ignore Rules – an effect causes listed conditions to be skipped entirely.
 *    Example: True Strike on the attacker → ignore "concealed" and "invisible" on the target.
 *
 * 2. Replace Rules – an effect replaces one condition with another.
 *    Example: See the Unseen on the attacker → replace "invisible" with "concealed" on the target.
 *
 * Both are registered via the module API exposed on game.modules.get("pf2-flat-check").api:
 *
 *   api.registerIgnoreEffect(slug, conditions, effectTarget)
 *   api.registerReplaceEffect(slug, from, to, effectTarget)
 *
 * effectTarget:
 *   "self" | "attacker"  →  look for the item/effect on the attacking token's actor (default)
 *   "target"             →  look for the item/effect on the target token's actor
 *
 * Other modules can hook into registration:
 *   Hooks.on("pf2-flat-check.registerEffectRules", (api) => { ... })
 */

const ignoreRules = [];
const replaceRules = [];

function actorHasEffect(actor, slug) {
  if (!actor) return false;
  return !!actor.items?.find(
    (i) => i.slug === slug || i.system?.slug === slug
  );
}

function resolveActor(effectTarget, token, target) {
  if (effectTarget === "target") return target?.actor ?? null;
  // "self" / "attacker" (default)
  return token?.actor ?? null;
}

/**
 * Register an ignore rule.
 * @param {string}          slug          Item/effect slug to look for on the actor.
 * @param {string|string[]} conditions    Condition slug(s) to remove when the item is present.
 * @param {"self"|"attacker"|"target"} [effectTarget="self"]
 */
export function registerIgnoreEffect(slug, conditions, effectTarget = "self") {
  ignoreRules.push({
    slug,
    conditions: Array.isArray(conditions) ? conditions : [conditions],
    effectTarget,
  });
}

/**
 * Register a replace rule.
 * @param {string} slug          Item/effect slug to look for on the actor.
 * @param {string} from          Condition slug to replace.
 * @param {string} to            Condition slug to replace it with.
 * @param {"self"|"attacker"|"target"} [effectTarget="self"]
 */
export function registerReplaceEffect(slug, from, to, effectTarget = "self") {
  replaceRules.push({ slug, from, to, effectTarget });
}

/**
 * Apply all registered rules to the condition set.
 * Called after the condition set is built, before DC determination.
 *
 * @param {Set<string>}  conditionSet  Live set – modifications happen in-place.
 * @param {Token}        token         The attacking token.
 * @param {Token|null}   target        The target token, or null when checking attacker conditions.
 */
export function applyEffectRules(conditionSet, token, target) {
  for (const rule of ignoreRules) {
    const actor = resolveActor(rule.effectTarget, token, target);
    if (!actorHasEffect(actor, rule.slug)) continue;
    for (const condition of rule.conditions) {
      conditionSet.delete(condition);
    }
  }

  for (const rule of replaceRules) {
    const actor = resolveActor(rule.effectTarget, token, target);
    if (!actorHasEffect(actor, rule.slug)) continue;
    if (conditionSet.has(rule.from)) {
      conditionSet.delete(rule.from);
      conditionSet.add(rule.to);
    }
  }
}

export function getEffectRulesAPI() {
  return { registerIgnoreEffect, registerReplaceEffect };
}
