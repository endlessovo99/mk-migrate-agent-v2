// The caller owns durable storage. A write may start only after its intent is durable.
export function createExecutionJournal(journal) {
  let remoteWriteAttempted = false;
  let writeOutcomeUnknownStage;

  return {
    async write(event, invoke, summarize = () => ({})) {
      try {
        if (journal !== undefined) {
          if (typeof journal?.beforeWrite !== "function" || typeof journal?.afterWrite !== "function") {
            throw new Error("Execution journal requires beforeWrite and afterWrite functions.");
          }
          await journal.beforeWrite(structuredClone(event));
        }
      } catch (cause) {
        throw journalError(event.operation, "before", cause);
      }

      let response;
      let result;
      remoteWriteAttempted = true;
      try {
        response = await invoke();
        result = summarize(response);
      } catch (cause) {
        writeOutcomeUnknownStage = event.operation;
        const error = new Error(cause instanceof Error ? cause.message : String(cause), { cause });
        error.stage = event.operation;
        error.code = cause?.code || "execute.write_outcome_unknown";
        error.writeOutcomeUnknown = true;
        throw error;
      }

      try {
        if (journal !== undefined) {
          await journal.afterWrite(structuredClone({ ...event, result }));
        }
      } catch (cause) {
        writeOutcomeUnknownStage = event.operation;
        throw journalError(event.operation, "after", cause);
      }
      return response;
    },

    summary() {
      return {
        remoteWriteAttempted,
        writeOutcomeUnknown: Boolean(writeOutcomeUnknownStage),
        ...(writeOutcomeUnknownStage ? { writeOutcomeUnknownStage } : {})
      };
    }
  };
}

function journalError(stage, boundary, cause) {
  const error = new Error(
    boundary === "before"
      ? "Execution journal could not persist the write intent; this API write was not attempted."
      : "The API returned, but its acknowledgement could not be persisted; do not retry this write.",
    { cause }
  );
  error.stage = stage;
  error.code = `execute.journal_${boundary}_write_failed`;
  error.writeOutcomeUnknown = boundary === "after";
  return error;
}
