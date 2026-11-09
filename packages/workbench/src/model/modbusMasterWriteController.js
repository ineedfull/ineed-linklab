import { buildModbusWriteRequest } from './modbusWriteCommands.js';

/**
 * Owns confirmation and the single-write gate for a mounted master panel.
 * state contains confirmation, writingCommandId, results, actionError and the
 * dialog's deleteConfirmation. getContext reads the current endpoint/session,
 * running flag and config. The panel invalidates confirmations when those change.
 * A scheduler completion updates results/diagnostics only for the captured
 * endpoint/session; failures retain the captured transaction for diagnostics.
 */
export function createModbusMasterWriteController({
  state, getContext, scheduler, validateCommand, recordTransaction,
}) {
  return { requestConfirmation, confirm };

  function requestConfirmation(command) {
    if (!command.enabled || !getContext().running || !getContext().sessionId || state.writingCommandId) return;
    state.actionError = '';
    const validationError = validateCommand(command);
    if (validationError) {
      state.actionError = `写入指令“${command.name}”配置无效：${validationError}`;
      return;
    }
    state.deleteConfirmation = null;
    state.confirmation = {
      commandId: command.id,
      commandName: command.name,
      endpointId: getContext().endpointId,
      sessionId: getContext().sessionId,
      functionCode: command.functionCode,
      unitId: command.unitId,
      address: command.address,
      quantity: command.values.length,
      values: Array.from(command.values),
    };
  }

  async function confirm() {
    if (!state.confirmation || state.writingCommandId || !getContext().running || !getContext().sessionId) return;
    state.actionError = '';
    const source = state.confirmation;
    if (source.endpointId !== getContext().endpointId || source.sessionId !== getContext().sessionId) {
      state.confirmation = null;
      return;
    }
    const command = getContext().config.writeCommands.find(({ id }) => id === source.commandId);
    if (!command?.enabled) {
      state.confirmation = null;
      return;
    }
    const validationError = validateCommand(command);
    if (validationError) {
      state.actionError = `写入指令“${command.name}”配置无效：${validationError}`;
      state.confirmation = null;
      return;
    }
    state.writingCommandId = source.commandId;
    const request = buildModbusWriteRequest(command, source.endpointId);
    try {
      const transaction = await scheduler.executeImmediate({
        endpointId: getContext().endpointId, sessionId: getContext().sessionId, config: getContext().config, request,
      });
      if (!transaction) return;
      if (source.endpointId === getContext().endpointId && source.sessionId === getContext().sessionId) {
        setWriteResult(source.commandId, {
          success: true,
          createdAt: transaction.createdAt,
          durationMs: transaction.durationMs,
          error: null,
        });
        recordTransaction(transaction);
      }
    } catch (reason) {
      if (source.endpointId === getContext().endpointId && source.sessionId === getContext().sessionId) {
        state.actionError = errorMessage(reason);
        setWriteResult(source.commandId, {
          success: false,
          createdAt: reason?.transaction?.createdAt ?? Date.now(),
          durationMs: reason?.transaction?.durationMs ?? null,
          error: errorMessage(reason),
        });
        if (reason?.transaction) recordTransaction(reason.transaction);
      }
    } finally {
      if (state.writingCommandId === source.commandId) state.writingCommandId = null;
      if (state.confirmation?.commandId === source.commandId) state.confirmation = null;
    }
  }

  function setWriteResult(commandId, result) {
    const next = new Map(state.results);
    next.set(commandId, result);
    state.results = next;
  }

  function errorMessage(reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
