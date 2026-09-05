import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const directory = process.argv[2] || "release";
const files = (await readdir(directory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && /\.(AppImage|dmg|zip|exe|deb)$/i.test(entry.name)).map(entry => entry.name).sort();
if (!files.length) throw new Error(`No release installers found in ${directory}`);
const lines = [];
for (const file of files) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
  lines.push(`${hash.digest("hex")}  ${file}`);
}
await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`Checksummed ${files.length} installers`);
