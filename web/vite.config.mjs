import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export default {
  plugins: [{
    name: "precompress-static-assets",
    apply: "build",
    async writeBundle({ dir }, bundle) {
      for (const name of Object.keys(bundle)) {
        if (!/^assets\/.+-[\w-]{8,}\.(?:js|css)$/.test(name)) continue;
        const file = path.join(dir, name);
        // Use the bytes already written by Rollup, including final chunk URLs.
        const original = await readFile(file);
        if (original.length < 1024) continue;
        const [br, gz] = await Promise.all([
          brotli(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
          gzipAsync(original, { level: 9 }),
        ]);
        if (br.length < original.length) await writeFile(file + ".br", br);
        if (gz.length < original.length) await writeFile(file + ".gz", gz);
      }
    },
  }],
};
