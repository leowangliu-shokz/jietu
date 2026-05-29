import { loadChanges, saveChanges } from "./changes.js";
import { changesPath } from "./paths.js";

export const changeDeleteDisabledMessage = "Change deletion is disabled.";
const captureRunningChangeDeleteMessage = "Cannot delete changes while a capture is running.";

export class ChangeAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChangeAdminError";
    this.code = code;
  }
}

export async function deleteChangeAction(options = {}) {
  return deleteChangesAction({
    ...options,
    changeIds: [options.changeId]
  });
}

export async function deleteChangesAction(options = {}) {
  if (options.canDeleteChanges === false) {
    return {
      status: 403,
      payload: { ok: false, error: changeDeleteDisabledMessage }
    };
  }

  if (options.captureRunning) {
    return {
      status: 409,
      payload: { ok: false, error: captureRunningChangeDeleteMessage }
    };
  }

  try {
    const result = await deleteChangesArchive(options.changeIds, options);
    return {
      status: 200,
      payload: {
        ok: true,
        deletedChangeId: result.deletedChangeId,
        deletedChangeIds: result.deletedChangeIds,
        changeRefresh: result.changeRefresh,
        state: options.buildState ? await options.buildState() : null
      }
    };
  } catch (error) {
    if (error instanceof ChangeAdminError) {
      const status = error.code === "CHANGE_NOT_FOUND"
        ? 404
        : error.code === "CHANGE_ID_REQUIRED"
          ? 400
          : 409;
      return {
        status,
        payload: { ok: false, error: error.message }
      };
    }
    throw error;
  }
}

export async function deleteChangeArchive(changeId, options = {}) {
  return deleteChangesArchive([changeId], options);
}

export async function deleteChangesArchive(changeIds, options = {}) {
  const cleanChangeIds = cleanChangeIdList(changeIds);
  if (cleanChangeIds.length === 0) {
    throw new ChangeAdminError("CHANGE_ID_REQUIRED", "Change id is required.");
  }

  const changesFilePath = options.changesFilePath || changesPath;
  const changes = await loadChanges(changesFilePath);
  const existingChangeIds = new Set(changes.map((change) => String(change?.id || "").trim()).filter(Boolean));
  const missingChangeIds = cleanChangeIds.filter((changeId) => !existingChangeIds.has(changeId));
  if (missingChangeIds.length > 0) {
    throw new ChangeAdminError("CHANGE_NOT_FOUND", `Change not found: ${missingChangeIds.join(", ")}`);
  }

  const deleteSet = new Set(cleanChangeIds);
  const remainingChanges = changes.filter((change) => !deleteSet.has(String(change?.id || "").trim()));
  await saveChanges(remainingChanges, changesFilePath);

  return {
    deletedChangeId: cleanChangeIds[0],
    deletedChangeIds: cleanChangeIds,
    changeRefresh: {
      ok: true,
      count: remainingChanges.length
    }
  };
}

function cleanChangeIdList(changeIds) {
  const values = Array.isArray(changeIds) ? changeIds : [changeIds];
  return [...new Set(values.map((changeId) => String(changeId || "").trim()).filter(Boolean))];
}
