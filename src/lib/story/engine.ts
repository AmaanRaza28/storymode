import type { StoryChoice, StoryGame, StoryState } from "@/lib/story/types";

export function getNode(game: StoryGame, nodeId: string) {
  return game.nodes.find((node) => node.id === nodeId);
}

export function getChoices(
  game: StoryGame,
  nodeId: string,
  state: StoryState,
): StoryChoice[] {
  return game.choices.filter((choice) => {
    if (choice.fromNodeId !== nodeId) return false;
    return Object.entries(choice.conditions ?? {}).every(
      ([key, value]) => state[key] === value,
    );
  });
}

export function applyChoice(state: StoryState, choice: StoryChoice): StoryState {
  return { ...state, ...choice.stateEffects };
}

export function isPublishable(game: StoryGame) {
  const hasStartNode = game.nodes.some((node) => node.id === game.startNodeId);
  const choiceTargetsExist = game.choices.every((choice) =>
    game.nodes.some((node) => node.id === choice.toNodeId),
  );
  return hasStartNode && choiceTargetsExist && game.nodes.length >= 2;
}

