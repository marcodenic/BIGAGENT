/** Conservative classification of a simple shell invocation. Never infer an
 * executable from filenames, quoted source code, or a multi-command script. */
export function commandActivity(command: string) {
  const generic = { status: "command" as const, phase: "executing" as const, label: "RUNNING" };
  if (/[\n\r`]|\$\(/.test(command)) return generic;
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
  if (tokens.some(token => /[;&|<>]/.test(token))) return generic;
  while (tokens.length && /^[A-Za-z_][A-Za-z_0-9]*=/.test(tokens[0] ?? "")) tokens.shift();
  const words = tokens.map(token => token.replace(/^(['"])(.*)\1$/, "$2"));
  const executable = (words.shift() ?? "").split(/[\\/]/).pop()?.toLowerCase();
  const runner = /^(?:vitest|jest|pytest|py\.test|mocha|ava|tap)(?:\.exe)?$/.test(executable ?? "");
  const packageTest = /^(?:npm|pnpm|yarn|bun)$/.test(executable ?? "")
    && (/^(?:test|test:[\w:-]+)$/.test(words[0] ?? "")
      || words[0] === "run" && /^(?:test|test:[\w:-]+)$/.test(words[1] ?? "")
      || /^(?:exec|dlx)$/.test(words[0] ?? "") && /^(?:vitest|jest|mocha|ava)$/.test(words[1] ?? ""));
  const test = runner || packageTest
    || /^(?:cargo|go|dotnet)$/.test(executable ?? "") && words[0] === "test"
    || /^(?:python[\d.]*|py)$/.test(executable ?? "") && words[0] === "-m" && /^(?:pytest|unittest)$/.test(words[1] ?? "")
    || executable === "node" && words[0] === "--test"
    || executable === "npx" && /^(?:vitest|jest|mocha|ava)$/.test(words[0] ?? "");
  if (test) return { status: "testing" as const, phase: "testing" as const, label: "RUNNING TESTS" };
  const build = /^(?:npm|pnpm|yarn|bun|cargo|go|dotnet)$/.test(executable ?? "")
    && (words[0] === "build" || words[0] === "run" && words[1] === "build");
  return build ? { ...generic, label: "BUILDING" } : generic;
}
