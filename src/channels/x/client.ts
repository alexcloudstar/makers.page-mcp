import { ensureFreshAccessToken } from "../../auth/oauth2.js"
import { CredentialStore } from "../../auth/store.js"
import { NotAuthenticatedError } from "../../auth/errors.js"
import type { Config } from "../../config.js"
import { fetchWithTimeout } from "../../util/fetch-with-timeout.js"

export { NotAuthenticatedError }

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = "XApiError"
  }
}

export type XUser = {
  id: string
  username: string
  name: string
}

export type CreatedTweet = {
  id: string
  text: string
  url: string
}

export class XClient {
  private readonly credentialStore: CredentialStore

  constructor(private readonly config: Config) {
    this.credentialStore = new CredentialStore(config)
  }

  async isConnected(): Promise<boolean> {
    const credentials = await this.credentialStore.read()
    return credentials !== undefined
  }

  private async getAccessToken(): Promise<string> {
    return ensureFreshAccessToken(this.config, this.credentialStore)
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const accessToken = await this.getAccessToken()
    const response = await fetchWithTimeout(`https://api.x.com${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    })

    const body = await response.json().catch(() => undefined)

    if (!response.ok) {
      const message =
        (body as { title?: string; detail?: string } | undefined)?.detail ??
        (body as { title?: string } | undefined)?.title ??
        `X API request failed with status ${response.status}`
      throw new XApiError(message, response.status, body)
    }

    return body as T
  }

  async getMe(): Promise<XUser> {
    const result = await this.request<{ data: XUser }>("/2/users/me", { method: "GET" })
    return result.data
  }

  async createTweet(text: string): Promise<CreatedTweet> {
    const result = await this.request<{ data: { id: string; text: string } }>("/2/tweets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })

    return {
      id: result.data.id,
      text: result.data.text,
      url: `https://x.com/i/web/status/${result.data.id}`,
    }
  }
}
