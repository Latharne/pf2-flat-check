export const moduleId = "pf2-flat-check";

export const actorConditionMap = {
  blinded: -Infinity, //Just so it gets picked up. DC partially depends on target.
  dazzled: 5,
  grabbed: 5,
};

export const targetConditionMap = {
  concealed: 5,
  hidden: 11,
  invisible: 11, //Treated as Undetected
  undetected: 11,
};