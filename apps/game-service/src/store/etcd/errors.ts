import { GRPCDeadlineExceededError, GRPCUnavailableError } from "etcd3";

/** True if `error` means etcd could not be reached or did not answer in time. */
export function isEtcdUnavailable(error: unknown): boolean {
  // The client library's circuit breaker rejects calls with an error marked by this property (its name is just "Error").
  return error instanceof GRPCUnavailableError || error instanceof GRPCDeadlineExceededError ||
    (error instanceof Error && "isBrokenCircuitError" in error);
}
