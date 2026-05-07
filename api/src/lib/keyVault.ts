import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

let _client: SecretClient | null = null;

function getClient(): SecretClient {
  if (_client) return _client;
  const url = process.env.KEY_VAULT_URL;
  if (!url) {
    throw new Error("Falta la variable de entorno KEY_VAULT_URL.");
  }
  _client = new SecretClient(url, new DefaultAzureCredential());
  return _client;
}

export async function setSecret(name: string, value: string): Promise<void> {
  await getClient().setSecret(name, value);
}

export async function getSecret(name: string): Promise<string> {
  const r = await getClient().getSecret(name);
  return r.value ?? "";
}

export async function deleteSecret(name: string): Promise<void> {
  const poller = await getClient().beginDeleteSecret(name);
  await poller.pollUntilDone();
}
