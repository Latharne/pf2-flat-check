import { moduleId } from "./constants.js";
import { getCondition } from "./conditions.js";
import { getSetting } from "./utils.js";
import { getEffectRulesAPI, registerIgnoreEffect, registerReplaceEffect } from "./effectRules.js";

function debugFlow() {}

function registerSettings() {
  game.settings.register(moduleId, "hideRollValue", {
    name: `pf2-flat-check.settings.hideRollValue.name`,
    hint: `pf2-flat-check.settings.hideRollValue.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(moduleId, "ignoreConcealed", {
    name: `pf2-flat-check.settings.ignoreConcealed.name`,
    hint: `pf2-flat-check.settings.ignoreConcealed.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(moduleId, "ignoreGrabbed", {
    name: `pf2-flat-check.settings.ignoreGrabbed.name`,
    hint: `pf2-flat-check.settings.ignoreGrabbed.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(moduleId, "ignoreInvisibility", {
    name: `pf2-flat-check.settings.ignoreInvisibility.name`,
    hint: `pf2-flat-check.settings.ignoreInvisibility.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(moduleId, "usePf2eVisionerAdapter", {
    name: `pf2-flat-check.settings.usePf2eVisionerAdapter.name`,
    hint: `pf2-flat-check.settings.usePf2eVisionerAdapter.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(moduleId, "ignorePassiveActions", {
    name: `pf2-flat-check.settings.ignorePassiveActions.name`,
    hint: `pf2-flat-check.settings.ignorePassiveActions.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(moduleId, "ignoreReactionActions", {
    name: `pf2-flat-check.settings.ignoreReactionActions.name`,
    hint: `pf2-flat-check.settings.ignoreReactionActions.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
}

Hooks.once("init", registerSettings);

function getSystemFlags(message) {
  const pf2e = message?.flags?.pf2e;
  const sf2e = message?.flags?.sf2e;
  if (pf2e?.context || pf2e?.origin) return pf2e;
  if (sf2e?.context || sf2e?.origin) return sf2e;
  return pf2e ?? sf2e ?? {};
}

function getMessageContext(message) {
  return getSystemFlags(message)?.context ?? {};
}

function getMessageOrigin(message) {
  return getSystemFlags(message)?.origin ?? {};
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

function getItemFromMessage(message, actor) {
  let { item } = message;
  const originUUID = getMessageOrigin(message)?.uuid;
  const originItemMatch = typeof originUUID === "string" ? originUUID.match(/Item\.([A-Za-z0-9]+)/) : null;
  const originItemId = originItemMatch?.[1];

  // PF2E's synthetic unarmed strike messages can omit message.item.
  // Resolve the strike item from actor actions so grabbed/manipulate handling still works.
  if (!item && !message.isDamageRoll && originItemId === "xxPF2ExUNARMEDxx") {
    item =
      actor?.system?.actions?.find((action) => action?.type === "strike" && action?.item?.id === originItemId)?.item ??
      null;
  }
  return item;
}

function shouldHandleMessage(message, item) {
  const domains = getMessageContext(message)?.domains || [];
  if (domains.includes("damage") || domains.includes("attack-damage") || domains.includes("damage-received")) {
    debugFlow("shouldHandleMessage:skip-domain", { messageId: message?.id, domains, itemType: item?.type });
    return false;
  }
  if (message.rolls?.some((r) => r.options?.evaluatePersistent) || message.isDamageTakenRoll) {
    debugFlow("shouldHandleMessage:skip-persistent-or-damage-taken", {
      messageId: message?.id,
      itemType: item?.type,
      isDamageTakenRoll: message?.isDamageTakenRoll,
    });
    return false;
  }
  if (["ancestry", "effect", "feat", "melee", "weapon"].includes(item.type) && (!message.isRoll || message.isDamageRoll)) {
    debugFlow("shouldHandleMessage:skip-non-roll", {
      messageId: message?.id,
      itemType: item?.type,
      isRoll: message?.isRoll,
      isDamageRoll: message?.isDamageRoll,
    });
    return false;
  }
  if (item.type === "spell" && message.isRoll) {
    debugFlow("shouldHandleMessage:skip-spell-roll", { messageId: message?.id, itemType: item?.type });
    return false;
  }

  const isPassiveAbility = message.content.includes('icons/actions/Passive.webp');
  const isReaction = message.content.includes('icons/actions/Reaction.webp');
  if ((isPassiveAbility && getSetting("ignorePassiveActions")) || (isReaction && getSetting("ignoreReactionActions"))) {
    debugFlow("shouldHandleMessage:skip-passive-or-reaction", {
      messageId: message?.id,
      itemType: item?.type,
      isPassiveAbility,
      isReaction,
    });
    return false;
  }

  debugFlow("shouldHandleMessage:accepted", {
    messageId: message?.id,
    itemType: item?.type,
    isRoll: message?.isRoll,
    isDamageRoll: message?.isDamageRoll,
  });
  return true;
}

function detectAreaAttack(message) {
  const rollOptions = getMessageOrigin(message)?.rollOptions || [];
  return (
    rollOptions.includes("area-effect") ||
    rollOptions.includes("area-damage") ||
    rollOptions.includes("aura") ||
    message.content.includes('data-pf2-effect-area') ||
    getMessageContext(message)?.type === "self-effect"
  );
}

function getContextOptions(message) {
  const options = getMessageContext(message)?.options ?? [];
  return Array.isArray(options) ? options : [];
}

async function prepareFlatCheckData(message, token, actor, item, userID) {
  const areaAttack = detectAreaAttack(message);
  const contextOptions = getContextOptions(message);
  debugFlow("prepareFlatCheckData:start", {
    messageId: message?.id,
    token: token?.name,
    actor: actor?.name,
    item: item?.name,
    itemType: item?.type,
    areaAttack,
    contextOptions,
    targetCount: game.users.get(userID)?.targets?.size ?? 0,
  });
  const templateData = {};
  const { conditionName, DC } = await getCondition(
    token,
    null,
    item.type === "spell",
    item.system.traits.value,
    areaAttack,
    contextOptions
  );
  debugFlow("prepareFlatCheckData:actor-condition", {
    messageId: message?.id,
    actor: token?.name || actor?.name,
    conditionName,
    DC,
  });
  templateData.flatCheckDC = DC ?? 0;
  templateData.actor = {
    name: token?.name || actor.name,
    condition: conditionName,
  };

  templateData.targets = [];
  const targets = Array.from(game.users.get(userID)?.targets ?? []);
  let anyTargetUndetected = false;
  let targetCount = 1;
  for (const target of targets) {
    debugFlow("prepareFlatCheckData:target-start", {
      messageId: message?.id,
      attacker: token?.name,
      target: target?.name,
      targetId: target?.id,
    });
    const { conditionName: tCondition, DC: tDC } = await getCondition(
      token,
      target,
      item.type === "spell",
      null,
      areaAttack,
      contextOptions
    );
    debugFlow("prepareFlatCheckData:target-condition", {
      messageId: message?.id,
      attacker: token?.name,
      target: target?.name,
      conditionName: tCondition,
      DC: tDC,
    });
    if (!tCondition) {
      debugFlow("prepareFlatCheckData:target-skipped-no-condition", {
        messageId: message?.id,
        attacker: token?.name,
        target: target?.name,
      });
      continue;
    }

    const visibility = getGameSetting("pf2e", "metagame_tokenSetsNameVisibility", false);
    templateData.targets.push({
      name: visibility && [0, 20, 40].includes(target.document.displayName) ? "Target " + targetCount++ : target.name,
      condition: tCondition,
    });

    if (tDC > templateData.flatCheckDC) templateData.flatCheckDC = tDC;
    if (
      tCondition === "Undetected" ||
      target.actor.itemTypes?.condition.map((n) => n.name)?.includes("Undetected")
    ) {
      anyTargetUndetected = true;
    }
  }

  debugFlow("prepareFlatCheckData:done", {
    messageId: message?.id,
    flatCheckDC: templateData.flatCheckDC,
    actorCondition: templateData.actor.condition,
    targetConditions: templateData.targets.map((t) => ({ name: t.name, condition: t.condition })),
    anyTargetUndetected,
  });
  return { templateData, anyTargetUndetected };
}

async function showFlatCheckResult(templateData, userID, anyTargetUndetected, token, actor) {
  debugFlow("showFlatCheckResult:start", {
    actor: token?.name || actor?.name,
    flatCheckDC: templateData?.flatCheckDC,
    anyTargetUndetected,
    targetCount: templateData?.targets?.length ?? 0,
  });
  const flatCheckRoll = new Roll("1d20");
  await flatCheckRoll.evaluate();
  const rollingUser = game.users.get(userID) ?? game.user;
  if (game.dice3d) await game.dice3d.showForRoll(flatCheckRoll, rollingUser, true);

  templateData.flatCheckRollResult = !getSetting("hideRollValue")
    ? flatCheckRoll.result
    : flatCheckRoll.result < templateData.flatCheckDC
    ? game.i18n.localize("pf2-flat-check.results.failure")
    : game.i18n.localize("pf2-flat-check.results.success");

  templateData.flatCheckRollResultClass =
    flatCheckRoll.result < templateData.flatCheckDC ? "flat-check-failure" : "flat-check-success";

  debugFlow("showFlatCheckResult:roll-evaluated", {
    actor: token?.name || actor?.name,
    flatCheckDC: templateData.flatCheckDC,
    roll: flatCheckRoll.result,
    resultClass: templateData.flatCheckRollResultClass,
    anyTargetUndetected,
  });

  const content = await foundry.applications.handlebars.renderTemplate(
    `modules/${moduleId}/templates/flat-check.hbs`,
    templateData
  );
  await ChatMessage.create({
    content: content,
    speaker: ChatMessage.getSpeaker({
      token,
      actor,
      user: rollingUser,
    }),
    whisper: anyTargetUndetected ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : null,
    blind: anyTargetUndetected,
    flags: { "pf2-flat-check": true },
  });
  debugFlow("showFlatCheckResult:chat-created", {
    actor: token?.name || actor?.name,
    anyTargetUndetected,
    whispered: anyTargetUndetected,
  });
}

Hooks.once("ready", () => {
  // Expose the effect rules API on the module object.
  // Usage from macros or other modules:
  //   const api = game.modules.get("pf2-flat-check").api;
  //   api.registerIgnoreEffect("effect-true-strike", ["concealed", "invisible"], "self");
  //   api.registerReplaceEffect("effect-see-the-unseen", "invisible", "concealed", "self");
  //
  // effectTarget: "self"/"attacker" = effect is on the attacking token, "target" = on the target token
  const api = getEffectRulesAPI();
  game.modules.get(moduleId).api = api;

  // --- Default rules ---
  // True Strike (Effect: True Strike) on the attacker → ignore concealed and invisible on the target
  registerIgnoreEffect("spell-effect-true-strike", ["concealed", "invisible"], "self");
  registerIgnoreEffect("spell-effect-sure-strike", ["concealed", "invisible"], "self");
  // See the Unseen (Effect: See the Unseen) on the attacker → replace invisible with concealed on the target
  registerReplaceEffect("spell-effect-see-the-unseen", "invisible", "concealed", "self");
  // See the Unseen also covers undetected → replace with concealed
  registerReplaceEffect("spell-effect-see-the-unseen", "undetected", "concealed", "self");

  // Allow other modules to register their own rules.
  Hooks.callAll("pf2-flat-check.registerEffectRules", api);
});

Hooks.on("createChatMessage", async (message, data, userID) => {
  debugFlow("createChatMessage:start", {
    messageId: message?.id,
    userID,
    speakerActor: message?.speaker?.actor,
    speakerToken: message?.speaker?.token,
    isRoll: message?.isRoll,
    isDamageRoll: message?.isDamageRoll,
  });
  const activeGM = game.users.find((u) => u.isGM && u.active);
  if (!activeGM || game.user.id !== activeGM.id) {
    debugFlow("createChatMessage:skip-not-active-gm", {
      messageId: message?.id,
      activeGM: activeGM?.id,
      currentUser: game.user?.id,
    });
    return;
  }

  const actor = message?.actor ?? game.actors.get(message?.speaker?.actor);
  const token = message?.token ?? game.canvas.tokens.get(message?.speaker?.token);
  const item = getItemFromMessage(message, actor);
  debugFlow("createChatMessage:resolved-context", {
    messageId: message?.id,
    actor: actor?.name,
    token: token?.name,
    item: item?.name,
    itemType: item?.type,
  });
  if (!actor || !item) {
    debugFlow("createChatMessage:skip-missing-actor-or-item", {
      messageId: message?.id,
      hasActor: !!actor,
      hasItem: !!item,
    });
    return;
  }
  if (!shouldHandleMessage(message, item)) {
    debugFlow("createChatMessage:skip-shouldHandleMessage-false", {
      messageId: message?.id,
      item: item?.name,
      itemType: item?.type,
    });
    return;
  }

  const { templateData, anyTargetUndetected } = await prepareFlatCheckData(message, token, actor, item, userID);
  if (!templateData.actor.condition && !templateData.targets.length) {
    debugFlow("createChatMessage:skip-no-conditions", {
      messageId: message?.id,
      actorCondition: templateData?.actor?.condition,
      targets: templateData?.targets ?? [],
    });
    return;
  }

  await showFlatCheckResult(templateData, userID, anyTargetUndetected, token, actor);
  debugFlow("createChatMessage:done", {
    messageId: message?.id,
    actor: actor?.name,
    token: token?.name,
  });
});
