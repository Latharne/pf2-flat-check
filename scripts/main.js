import { moduleId } from "./constants.js";
import { getCondition } from "./conditions.js";
import { getSetting } from "./utils.js";

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

function getItemFromMessage(message, actor) {
  let { item } = message;
  const originUUID = message.flags.pf2e?.origin?.uuid;
  if (!item && !message.isDamageRoll && originUUID?.match(/Item.(\w+)/) && RegExp.$1 === "xxPF2ExUNARMEDxx") {
    const actionIds = originUUID.match(/Item.(\w+)/);
    if (actionIds && actionIds[1]) {
      item =
        actor?.system?.actions
          .filter((atk) => atk?.type === "strike")
          .filter((a) => a.item.id === actionIds[1]) || null;
    }
  }
  return item;
}

function shouldHandleMessage(message, item) {
  const domains = message.flags?.pf2e?.context?.domains || [];
  if (domains.includes("damage") || domains.includes("attack-damage") || domains.includes("damage-received")) {
    return false;
  }
  if (message.rolls?.some((r) => r.options?.evaluatePersistent) || message.isDamageTakenRoll) {
    return false;
  }
  if (["ancestry", "effect", "feat", "melee", "weapon"].includes(item.type) && (!message.isRoll || message.isDamageRoll)) {
    return false;
  }
  if (item.type === "spell" && message.isRoll) return false;

  const isPassiveAbility = message.content.includes('icons/actions/Passive.webp');
  const isReaction = message.content.includes('icons/actions/Reaction.webp');
  if ((isPassiveAbility && getSetting("ignorePassiveActions")) || (isReaction && getSetting("ignoreReactionActions"))) {
    return false;
  }
  return true;
}

function detectAreaAttack(message) {
  const rollOptions = message.flags?.pf2e?.origin?.rollOptions || [];
  return (
    rollOptions.includes("area-effect") ||
    rollOptions.includes("area-damage") ||
    rollOptions.includes("aura") ||
    message.content.includes('data-pf2-effect-area') ||
    message.flags?.pf2e?.context?.type === "self-effect"
  );
}

function prepareFlatCheckData(message, token, actor, item, userID) {
  const areaAttack = detectAreaAttack(message);
  const templateData = {};
  const { conditionName, DC } = getCondition(
    token,
    null,
    item.type === "spell",
    item.system.traits.value,
    areaAttack
  );
  templateData.flatCheckDC = DC ?? 0;
  templateData.actor = {
    name: token?.name || actor.name,
    condition: conditionName,
  };

  templateData.targets = [];
  const targets = Array.from(game.users.get(userID).targets);
  let anyTargetUndetected = false;
  let targetCount = 1;
  for (const target of targets) {
    const { conditionName: tCondition, DC: tDC } = getCondition(
      token,
      target,
      item.type === "spell",
      null,
      areaAttack
    );
    if (!tCondition) continue;

    const visibility = game.settings.get("pf2e", "metagame_tokenSetsNameVisibility");
    templateData.targets.push({
      name: visibility && [0, 20, 40].includes(target.document.displayName) ? "Target " + targetCount++ : target.name,
      condition: tCondition,
    });

    if (tDC > templateData.flatCheckDC) templateData.flatCheckDC = tDC;
    if (target.actor.itemTypes?.condition.map((n) => n.name)?.includes("Undetected")) anyTargetUndetected = true;
  }

  return { templateData, anyTargetUndetected };
}

async function showFlatCheckResult(templateData, userID, anyTargetUndetected, token, actor) {
  const flatCheckRoll = new Roll("1d20");
  await flatCheckRoll.evaluate();
  if (game.dice3d) await game.dice3d.showForRoll(flatCheckRoll, game.users.get(userID), true);

  templateData.flatCheckRollResult = !getSetting("hideRollValue")
    ? flatCheckRoll.result
    : flatCheckRoll.result < templateData.flatCheckDC
    ? game.i18n.localize("pf2-flat-check.results.failure")
    : game.i18n.localize("pf2-flat-check.results.success");

  templateData.flatCheckRollResultClass =
    flatCheckRoll.result < templateData.flatCheckDC ? "flat-check-failure" : "flat-check-success";

  const content = await foundry.applications.handlebars.renderTemplate(
    `modules/${moduleId}/templates/flat-check.hbs`,
    templateData
  );
  await ChatMessage.create({
    content: content,
    speaker: ChatMessage.getSpeaker({
      token,
      actor,
      user: game.users.get(userID),
    }),
    whisper: anyTargetUndetected ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : null,
    blind: anyTargetUndetected,
    flags: { "pf2-flat-check": true },
  });
}

Hooks.on("createChatMessage", async (message, data, userID) => {
  if (game.user.id !== game.users.find((u) => u.isGM && u.active).id) return;

  const actor = message?.actor ?? game.actors.get(message?.speaker?.actor);
  const token = message?.token ?? game.canvas.tokens.get(message?.speaker?.token);
  const item = getItemFromMessage(message, actor);
  if (!actor || !item) return;
  if (!shouldHandleMessage(message, item)) return;

  const { templateData, anyTargetUndetected } = prepareFlatCheckData(message, token, actor, item, userID);
  if (!templateData.actor.condition && !templateData.targets.length) return;

  await showFlatCheckResult(templateData, userID, anyTargetUndetected, token, actor);
});
