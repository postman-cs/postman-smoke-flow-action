type JsonRecord = Record<string, unknown>;

/** Surface consumed by the Smoke reshape runner (gateway-backed in production). */
export interface SmokeCollectionClient {
  generateCollection(specId: string, projectName: string, prefix: string): Promise<string>;
  getCollection(collectionUid: string): Promise<JsonRecord>;
  updateCollection(collectionUid: string, collection: unknown): Promise<void>;
  deleteCollection(collectionUid: string): Promise<void>;
}
