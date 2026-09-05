import { expect, it } from "vitest";
import { commandActivity } from "./command-activity";
it.each(["pnpm test", "npm run test:unit", "pnpm exec vitest run", "python3 -m pytest", "go test ./...", "cargo test", "CI=1 /usr/bin/pytest tests", "node --test", "npx jest"])("recognizes test invocation %s", command => expect(commandActivity(command).status).toBe("testing"));
it.each(["cat src/foo.test.ts", "rg testing src", "git checkout tests", "echo 'pnpm test'", "node script.js tests", "test -f package.json", "python3 -c 'print(\"pytest\")'", "cat <<'EOF'\npnpm test\nEOF", "pnpm test && pnpm build"])("does not invent test execution for %s", command => expect(commandActivity(command).status).toBe("command"));
