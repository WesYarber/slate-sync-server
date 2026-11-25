import { loadConfig } from "./config";
import { Store } from "./store";

// Account admin, run on the server: `bun run admin <command>`.

const usage = `Usage: bun run admin <command>

  create-account <name>          Make an account and print its first token
  new-token <name> [label]       Print another token for the account (one per device, say)
  revoke-tokens <name>           Remove every token of the account (its data stays)
  delete-account <name>          Remove the account and all its data
  list                           Accounts, with token count and storage used

Uses DATA_DIR (default ./data), like the server.`;

const [command, name, label] = process.argv.slice(2);
const store = new Store(loadConfig().dataDir);

function need(name: string | undefined): string {
  if (!name) {
    console.error(usage);
    process.exit(2);
  }
  return name;
}

function find(name: string) {
  const account = store.account(name);
  if (!account) {
    console.error(`No account named "${name}".`);
    process.exit(1);
  }
  return account;
}

switch (command) {
  case "create-account": {
    const accountName = need(name);
    if (store.account(accountName)) {
      console.error(`An account named "${accountName}" already exists. Use new-token for another token.`);
      process.exit(1);
    }
    const account = store.createAccount(accountName);
    console.log(store.newToken(account.id, label ?? "first"));
    break;
  }
  case "new-token":
    console.log(store.newToken(find(need(name)).id, label ?? ""));
    break;
  case "revoke-tokens":
    console.log(`Removed ${store.revokeTokens(find(need(name)).id)} token(s).`);
    break;
  case "delete-account":
    store.deleteAccount(find(need(name)).id);
    console.log(`Deleted "${name}".`);
    break;
  case "list": {
    const rows = store.accounts();
    if (!rows.length) console.log("No accounts yet.");
    for (const a of rows) {
      console.log(`${a.name}\t${a.tokens} token(s)\t${a.objects} object(s)\t${(a.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    break;
  }
  default:
    console.error(usage);
    process.exit(command ? 2 : 0);
}
store.close();
