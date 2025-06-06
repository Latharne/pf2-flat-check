const moduleId = "pf2-flat-check";

const actorConditionMap = {
  blinded: -Infinity, //Just so it gets picked up. DC partially depends on target.
  dazzled: 5,
};

const targetConditionMap = {
  concealed: 5,
  hidden: 11,
  invisible: 11, //Treated as Undetected
  undetected: 11,
};

Hooks.once("init", () => {
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
});

Hooks.on("createChatMessage", async (message, data, userID) => {
  if (game.user.id !== game.users.find((u) => u.isGM && u.active).id) return;

  const actor = message?.actor ?? game.actors.get(message?.speaker?.actor);
  const token = message?.token ?? game.canvas.tokens.get(message?.speaker?.token);
  let { item } = message;
  const originUUID = message.flags.pf2e?.origin?.uuid;
  //console.log(message);
  //Domäne prüfen, falls Schaden, dann Abbruch
  const domains = message.flags?.pf2e?.context?.domains || [];
  if (domains.includes("damage") || domains.includes("attack-damage") || domains.includes("damage-received")) {
    return;
}
//Falls der Wurf persistenten Schaden enthält dann Abbruch
if (message.rolls?.some(roll => roll.options?.evaluatePersistent) || (message.isDamageTakenRoll)) {
  return;
}
  if (
    !item &&
    !message.isDamageRoll &&
    originUUID?.match(/Item.(\w+)/) &&
    RegExp.$1 === "xxPF2ExUNARMEDxx"
  ) {
    const actionIds = originUUID.match(/Item.(\w+)/);
    if (actionIds && actionIds[1]) {
      item =
        actor?.system?.actions
          .filter((atk) => atk?.type === "strike")
          .filter((a) => a.item.id === actionIds[1]) || null;
    }
  }
  if (!actor || !item) return;
  if (
    ["ancestry", "effect", "feat", "melee", "weapon"].includes(item.type) &&
    (!message.isRoll || message.isDamageRoll)
  )
    return;
  if (item.type === "spell" && message.isRoll) return;

  const ignorePassiveActions = game.settings.get(moduleId,"ignorePassiveActions");
  const ignoreReactionActions = game.settings.get(moduleId,"ignoreReactionActions");
  const isPassiveAbility = message.content.includes('icons/actions/Passive.webp');
  const isReaction = message.content.includes('icons/actions/Reaction.webp');

  if ((isPassiveAbility && ignorePassiveActions) || (isReaction && ignoreReactionActions)) {
    return;
}
  let areaAttack = false;
  const rollOptions = message.flags?.pf2e?.origin?.rollOptions || [];
  if (rollOptions.includes("area-effect") || rollOptions.includes("area-damage") || 
      rollOptions.includes("aura") || message.content.includes('data-pf2-effect-area') ||
      message.flags?.pf2e?.context?.type === "self-effect") {
    areaAttack = true;
  }
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
    const { conditionName, DC } = getCondition(
      token,
      target,
      item.type === "spell",
      null,
      areaAttack
    );
    if (!conditionName) continue;

    const visibility = game.settings.get(
      "pf2e",
      "metagame_tokenSetsNameVisibility"
    );
    templateData.targets.push({
      name:
        visibility && [0, 20, 40].includes(target.document.displayName)
          ? "Target " + targetCount++
          : target.name,
      condition: conditionName,
    });

    if (DC > templateData.flatCheckDC) templateData.flatCheckDC = DC;
    if (
      target.actor.itemTypes?.condition
        .map((n) => n.name)
        ?.includes("Undetected")
    )
      anyTargetUndetected = true;
  }

  if (!templateData.actor.condition && !templateData.targets.length) return;

  const flatCheckRoll = new Roll("1d20");
  await flatCheckRoll.evaluate();
  if (game.dice3d)
    await game.dice3d.showForRoll(flatCheckRoll, game.users.get(userID), true);

  templateData.flatCheckRollResult = !game.settings.get(
    moduleId,
    "hideRollValue"
  )
    ? flatCheckRoll.result
    : flatCheckRoll.result < templateData.flatCheckDC
      ? game.i18n.localize("pf2-flat-check.results.failure")
      : game.i18n.localize("pf2-flat-check.results.success");

  templateData.flatCheckRollResultClass =
    flatCheckRoll.result < templateData.flatCheckDC
      ? "flat-check-failure"
      : "flat-check-success";

  const content = await renderTemplate(
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
    whisper: anyTargetUndetected
      ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
      : null,
    blind: anyTargetUndetected,
    flags: { "pf2-flat-check": true },
  });
});

function distanceBetween(token0, token1) {
  const ray = new Ray(
    new PIXI.Point(token0?.x || 0, token0?.y || 0),
    new PIXI.Point(token1?.x || 0, token1?.y || 0)
  );
  const x = Math.ceil(Math.abs(ray.dx / canvas.dimensions.size));
  const y = Math.ceil(Math.abs(ray.dy / canvas.dimensions.size));
  return (
    Math.floor(Math.min(x, y) + Math.abs(y - x)) * canvas.dimensions.distance
  );
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
    hasMothSupportEffect: !!attacker?.items.some(i =>
      i.type === "effect" && i.name === "Effect: Moth Support Benefit"
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

  const conditions = currentActor.itemTypes.condition
    .filter((c) => {
      if (checkingAttacker && isSpell && c.slug === "stupefied") return true;
      if (["hidden", "concealed", "undetected", "dazzled"].includes(c.slug) && usePf2ePerceptionInstead())
        return false;
      return Object.keys(conditionMap).includes(c.slug);
    })
    .map((c) => c.slug)
    .sort();

  if (!checkingAttacker && info.blinded && !conditions.includes("hidden") && !usePf2ePerceptionInstead())
    conditions.push("hidden");
  if (!checkingAttacker && info.dazzled && !conditions.includes("concealed") && !usePf2ePerceptionInstead())
    conditions.push("concealed");

  if (!checkingAttacker && game.modules.get("pf2e-darkness-effects")?.active) {
    const attackerLowLightVision = token.actor.system.traits.senses.some((s) => s.type === "lowLightVision");
    const targetInDimLight = currentActor.getFlag("pf2e-darkness-effects", "darknessLevel") === 1;
    if (targetInDimLight && !attackerLowLightVision && !conditions.includes("concealed"))
      conditions.push("concealed");

    const attackerDarkvision = token.actor.system.traits.senses.some((s) => s.type === "darkvision");
    const targetInDarkness = currentActor.getFlag("pf2e-darkness-effects", "darknessLevel") === 0;
    if (targetInDarkness && !attackerDarkvision && !conditions.includes("hidden"))
      conditions.push("hidden");
  }

  let stupefyLevel;
  if (conditions.includes("stupefied")) {
    stupefyLevel = currentActor.itemTypes.condition.find((c) => c.slug === "stupefied")?.value;
    if (stupefyLevel) conditionMap["stupefied"] = stupefyLevel + 5;
  }

  return { conditions, stupefyLevel };
}

function determineCondition(conditionList, stupefyLevel, conditionMap, info, checkingAttacker, traits) {
  if (!conditionList || conditionList.length === 0) return {};

  // 1. Ursprünglich härteste Bedingung ermitteln (höchster conditionMap-DC)
  let baseCondition = conditionList.reduce((acc, curr) => {
    const accDC = conditionMap[acc] ?? -Infinity;
    const currDC = conditionMap[curr] ?? -Infinity;
    return accDC >= currDC ? acc : curr;
  });

  console.log(baseCondition);

  let logicalCondition = baseCondition;
  if (logicalCondition === "invisible" || baseCondition === "undetected") {
    logicalCondition = "hidden";
  }
  // 2. DC initial setzen
  let DC = conditionMap[logicalCondition];

  // 3. Spezialfälle behandeln (z. B. stupefied-Level)
  if (baseCondition === "stupefied" && typeof stupefyLevel === "number") {
    DC = stupefyLevel + 5;
  }

  // 4. Reduktionen anwenden
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

  // 5. Sonderfall "grabbed" bei Angreifer und Manipulate
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

function getCondition(token, target, isSpell, traits, areaAttack) {
  const ignoreConcealed = game.settings.get(moduleId, "ignoreConcealed");
  const ignoreGrabbed = game.settings.get(moduleId, "ignoreGrabbed");
  const ignoreInvisibility = game.settings.get(moduleId, "ignoreInvisibility");

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
    condition && condition.length > 0
      ? condition.charAt(0).toUpperCase() + condition.slice(1)
      : condition;

  if (shouldIgnoreCondition(conditionName, areaAttack, ignoreConcealed, ignoreInvisibility, ignoreGrabbed)) {
    return {};
  }
  return { conditionName, DC };
}

function usePf2ePerceptionInstead() {
  return game.modules.get("pf2e-perception")?.active && ['roll', 'cancel'].includes(game.settings.get("pf2e-perception", "flat-check"))
}