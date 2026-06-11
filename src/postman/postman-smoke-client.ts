import { adviseFromSmokeClientStatus, type SmokeCallContext } from '../lib/error-advice.js';
import { HttpError } from '../lib/errors.js';

type JsonRecord = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isDeepUpdateConflict(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 409) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes('deepupdate') || message.includes('currently being modified');
}

export class PostmanSmokeClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.getpostman.com',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
    callContext?: SmokeCallContext,
    collectionId?: string
  ): Promise<JsonRecord | null> {
    const url = path.startsWith('http') ? path : `${this.baseUrl.replace(/\/+$/g, '')}${path}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const httpErr = await HttpError.fromResponse(response, url, init.method ?? 'GET');
      if (callContext !== undefined && collectionId !== undefined) {
        const advice = adviseFromSmokeClientStatus(response.status, collectionId, callContext);
        if (advice !== undefined) {
          throw new Error(advice, { cause: httpErr });
        }
      }
      throw httpErr;
    }
    try {
      return (await response.json()) as JsonRecord;
    } catch {
      return null;
    }
  }

  private extractCollectionUid(data: unknown): string | undefined {
    const root = asRecord(data);
    const details = asRecord(root?.details);
    const resources = Array.isArray(details?.resources) ? details.resources : [];
    const firstResource = asRecord(resources[0]);
    const collection = asRecord(root?.collection);
    const resource = asRecord(root?.resource);
    return String(
      firstResource?.id ??
      collection?.id ??
      collection?.uid ??
      resource?.uid ??
      resource?.id ??
      ''
    ).trim() || undefined;
  }

  async generateCollection(specId: string, projectName: string, prefix: string): Promise<string> {
    const payload = {
      name: `${prefix} ${projectName}`,
      options: {
        requestNameSource: 'Fallback'
      }
    };

    let generationResponse: JsonRecord | null | undefined;
    const maxLockedRetries = 5;

    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      try {
        generationResponse = await this.request(
          `/specs/${specId}/generations/collection`,
          { method: 'POST', body: JSON.stringify(payload) },
          'write',
          specId
        );
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isLocked = message.includes('423');
        if (!isLocked || lockedAttempt >= maxLockedRetries) {
          throw error;
        }
        await this.sleepImpl(5000 * Math.pow(2, lockedAttempt));
      }
    }

    if (!generationResponse) {
      throw new Error(`Collection generation request did not return a response for ${prefix}`);
    }

    const directUid = this.extractCollectionUid(generationResponse);
    if (directUid) {
      return directUid;
    }

    let taskUrl =
      String(generationResponse.url ?? '') ||
      String(generationResponse.task_url ?? '') ||
      String(generationResponse.taskUrl ?? '') ||
      String(asRecord(generationResponse.links)?.task ?? '');
    if (!taskUrl) {
      const task = asRecord(generationResponse.task);
      const taskId = generationResponse.taskId ?? task?.id ?? generationResponse.id;
      if (!taskId) {
        throw new Error(`Collection generation did not return a task URL or ID for ${prefix}`);
      }
      taskUrl = `/specs/${specId}/tasks/${taskId}`;
    }

    for (let attempt = 0; attempt < 45; attempt += 1) {
      await this.sleepImpl(2000);
      const task = await this.request(taskUrl);
      const taskRecord = asRecord(task);
      const nestedTask = asRecord(taskRecord?.task);
      const status = String(taskRecord?.status ?? nestedTask?.status ?? '').toLowerCase();
      if (status === 'completed') {
        const taskUid = this.extractCollectionUid(task);
        if (!taskUid) {
          throw new Error(`Task completed but no collection UID was returned for ${prefix}`);
        }
        return taskUid;
      }
      if (status === 'failed') {
        throw new Error(`Collection generation task failed for ${prefix}`);
      }
    }

    throw new Error(`Collection generation timed out for ${prefix}`);
  }

  async getCollection(collectionUid: string): Promise<JsonRecord> {
    const response = await this.request(
      `/collections/${collectionUid}`,
      {},
      'read',
      collectionUid
    );
    const collection = asRecord(response?.collection);
    if (!collection) {
      throw new Error(`Failed to fetch collection ${collectionUid}`);
    }
    return collection;
  }

  async updateCollection(collectionUid: string, collection: unknown): Promise<void> {
    const maxDeepUpdateRetries = 8;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.request(
          `/collections/${collectionUid}`,
          { method: 'PUT', body: JSON.stringify({ collection }) },
          'write',
          collectionUid
        );
        return;
      } catch (error) {
        if (!isDeepUpdateConflict(error) || attempt >= maxDeepUpdateRetries) {
          throw error;
        }
        await this.sleepImpl(Math.min(30000, 5000 * Math.pow(2, attempt)));
      }
    }
  }

  async deleteCollection(collectionUid: string): Promise<void> {
    try {
      await this.request(`/collections/${collectionUid}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return;
      }
      throw error;
    }
  }
}
