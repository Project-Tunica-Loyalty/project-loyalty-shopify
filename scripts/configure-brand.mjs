import { readFile, writeFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index];
  const value = process.argv[index + 1];
  if (!option?.startsWith("--") || !value || value.startsWith("--")) {
    throw new Error("Usage: npm run brand:config -- --client-id ID --app-url https://app.example.com --name NAME");
  }
  args.set(option, value);
}

const clientId = args.get("--client-id");
const appUrl = args.get("--app-url");
const name = args.get("--name");
if (!clientId || !name || !appUrl || !/^[a-f0-9]{32}$/i.test(clientId)) {
  throw new Error("Provide the Shopify client ID (32 hex characters), HTTPS app URL, and brand app name");
}
const url = new URL(appUrl);
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  throw new Error("--app-url must be an HTTPS origin without a path, query, or credentials");
}
const origin = url.origin;
const toml = await readFile(new URL("../shopify.app.toml", import.meta.url), "utf8");
const updated = toml
  .replace(/^client_id = .*$/m, `client_id = ${JSON.stringify(clientId)}`)
  .replace(/^name = .*$/m, `name = ${JSON.stringify(name)}`)
  .replace(/^application_url = .*$/m, `application_url = ${JSON.stringify(origin)}`)
  .replace(/^redirect_urls = .*$/m, `redirect_urls = [${JSON.stringify(`${origin}/auth/callback`)}]`);
if (updated === toml || updated.includes("https://shopify.reglrs.ai")) {
  throw new Error("Could not replace the Shopify app configuration fields");
}
const output = new URL("../shopify.app.brand.toml", import.meta.url);
await writeFile(output, updated, { flag: "wx" });
console.log("Created shopify.app.brand.toml. Review it, then deploy this app configuration with Shopify CLI.");
