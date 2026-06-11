/**
 * Reactive error-advice layer for smoke-flow (PMAK-only subset).
 *
 * Returns masking-safe static guidance interpolating only the collection id
 * and static text; never a credential value.
 */

export type SmokeCallContext = 'read' | 'write';

/**
 * Maps a non-2xx HTTP status from the Postman public API to a single
 * actionable guidance string, or undefined when no known mapping applies.
 *
 * @param status      HTTP status code from the failed response.
 * @param collectionId  The collection uid being operated on.
 * @param callContext   Whether the call was reading or writing the collection.
 */
export function adviseFromSmokeClientStatus(
  status: number,
  collectionId: string,
  callContext: SmokeCallContext
): string | undefined {
  if (status === 401 || status === 403) {
    const verb = callContext === 'write' ? 'writing' : 'reading';
    return `postman-api-key rejected ${verb} collection ${collectionId}; confirm the key's team owns this collection`;
  }
  if (status === 404) {
    return `collection ${collectionId} not found for this key's team; a wrong-team key is the usual cause`;
  }
  return undefined;
}
