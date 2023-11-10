import * as path from "path";

const weightsPath = Bun.argv[2];
if (!weightsPath) {
  console.log("Usage: bun run katago.ts <weights.bin.gz>");
  process.exit(1);
}

const executablePath =
  process.env.EXE_PATH ?? path.join(process.cwd(), "./KataGo/cpp/katago");
const configPath = path.join(import.meta.dir, "./config.cfg");
const sgfPath = path.join(import.meta.dir, "./game.sgf");

const katago = Bun.spawn(
  [executablePath, "gtp", `-model ${weightsPath}`, `-config ${configPath}`],
  {
    stdin: "pipe",
    stdout: "pipe",
  }
);

const reader = katago.stdout.getReader();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const getInput = async (waitFor = "=") => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) process.exit(1);
    const output = decoder.decode(value);
    console.log("> " + output);
    if (!waitFor || output.includes(waitFor)) return output;
  }
};
const gtpCommand = async (command: string, waitFor?: string) => {
  const inPromise = getInput(waitFor);
  katago.stdin.write(encoder.encode(command + "\n"));
  return await inPromise;
};

await gtpCommand(`loadsgf ${sgfPath}`);
const boardInfo = await gtpCommand("showboard");
const match = boardInfo.match(/Next player: (Black|White)/);
if (!match) {
  console.log("Board info");
  console.log(boardInfo);
  throw new Error("Could not parse board info");
}

const playerToPlay = match[1].toLocaleLowerCase() === "black" ? "b" : "w";
const genMoveResult = await gtpCommand(`genmove ${playerToPlay}`, "=");
console.log("MOVE RESULT: ", genMoveResult);

const value = genMoveResult.split("=").at(-1)?.trim() ?? "";
console.log("VALUE: ", value);

const serverUrl = process.env.SERVER_URL;
const secret = process.env.AI_MOVE_SECRET;
if (!serverUrl || !secret) {
  throw new Error("Missing SERVER_URL or AI_MOVE_SECRET");
}

if (value === "resign") {
  console.log("Finishing the game by resignation", value);
  const player = playerToPlay === "b" ? "W" : "B";
  const response = await fetch(`${serverUrl}/gh_game/finish`, {
    method: "POST",
    body: JSON.stringify({
      result: `${player}+R`,
      reason: "resign",
      aiMove: secret,
    }),
  });
  if (!response.ok) throw new Error("Could not update game");
} else if (value === "pass") {
  const gameResult = await gtpCommand(`final_score ${playerToPlay}`, "=");
  const value = gameResult.split("=").at(-1)?.trim() ?? "";
  console.log("Finishing the game with result: ", value);
  const response = await fetch(`${serverUrl}/gh_game/finish`, {
    method: "POST",
    body: JSON.stringify({
      result: value,
      reason: "pass",
      aiMove: secret,
    }),
  });
  if (!response.ok) throw new Error("Could not update game");
} else {
  console.log(`Playing move for ${playerToPlay} at point ${value}`);

  const response = await fetch(`${serverUrl}/gh_game/update`, {
    method: "POST",
    body: JSON.stringify({
      move: value,
      stone: playerToPlay,
      aiMove: secret,
    }),
  });
  if (!response.ok) throw new Error("Could not update game");
}

katago.stdin.write(encoder.encode("quit\n"));
