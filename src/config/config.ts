import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDir, writeFileAtomic } from "../utils/fs.js";
import { errorCode } from "../utils/errors.js";

export class ConfigError extends Error {}

export interface TelegramConfig {
  botUsername: string;
  chatId: string;
  token: string;
}

export interface Encrypted {
  iv: string;
  tag: string;
  data: string;
}

const ConfigFile = z.object({
  version: z.literal(1),
  telegram: z.object({
    botUsername: z.string().min(1),
    chatId: z.string().regex(/^-?\d+$/),
    token: z.object({ iv: z.string(), tag: z.string(), data: z.string() }),
  }),
});

const KEY_BYTES = 32;

export function encrypt(key: Buffer, plaintext: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decrypt(key: Buffer, value: Encrypted): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
}

// The token is encrypted with a key kept in a separate 0600 file next to it. That keeps it out of
// backups, synced dotfiles and greps, but not from someone who can read the whole directory.
export class ConfigStore {
  readonly configPath: string;
  readonly keyPath: string;

  constructor(readonly dir: string) {
    this.configPath = join(dir, "config.json");
    this.keyPath = join(dir, "secret.key");
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  load(): TelegramConfig | null {
    if (!this.exists()) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.configPath, "utf8"));
    } catch {
      throw new ConfigError(`${this.configPath} is not valid JSON; run \`pr-tools-notifier init\` again`);
    }
    const parsed = ConfigFile.safeParse(raw);
    if (!parsed.success) throw new ConfigError(`${this.configPath} is invalid: ${z.prettifyError(parsed.error)}`);

    const key = this.readKey();
    if (!key) throw new ConfigError(`${this.keyPath} is missing; run \`pr-tools-notifier init\` again`);
    const { botUsername, chatId, token } = parsed.data.telegram;
    try {
      return { botUsername, chatId, token: decrypt(key, token) };
    } catch {
      throw new ConfigError("cannot decrypt the bot token (secret.key does not match); run `pr-tools-notifier init` again");
    }
  }

  save(config: TelegramConfig): void {
    ensurePrivateDir(this.dir);
    const key = this.readKey() ?? this.createKey();
    const file = {
      version: 1,
      telegram: { botUsername: config.botUsername, chatId: config.chatId, token: encrypt(key, config.token) },
    };
    writeFileAtomic(this.configPath, JSON.stringify(file, null, 2));
  }

  private readKey(): Buffer | null {
    try {
      const key = readFileSync(this.keyPath);
      if (key.length !== KEY_BYTES)
        throw new ConfigError(`${this.keyPath} is damaged; delete it and run \`pr-tools-notifier init\` again`);
      return key;
    } catch (err) {
      if (errorCode(err) === "ENOENT") return null;
      throw err;
    }
  }

  private createKey(): Buffer {
    const key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(this.keyPath, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      return this.readKey()!;
    }
  }
}
