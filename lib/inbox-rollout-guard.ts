/** Deployment holds are separate from queue data: observing progress never grants submission authority. */
export type InboxRolloutGuard = {version:1;installedAt:string;protectedQueueHashes:string[];protectedCommandIds:string[];reason:string};
export const rolloutProtectsQueue=(guard:InboxRolloutGuard|null,hash:string|undefined)=>!!hash&&!!guard?.protectedQueueHashes?.includes(hash);
export const rolloutProtectsCommand=(guard:InboxRolloutGuard|null,id:string)=>!!guard?.protectedCommandIds?.includes(id);
