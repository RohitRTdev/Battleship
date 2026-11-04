import { GRPCCancelledError, GRPCDeadlineExceededError, GRPCUnavailableError } from "etcd3";

/** True if `error` means etcd could not be reached or did not answer in time. */
export function isEtcdUnavailable(error: unknown): boolean {
  // The client library's circuit breaker rejects calls with an error marked by this property (its name is just "Error").
  // CANCELLED: when one call fails on a connection, the library resets it, cancelling the other calls in flight on it;
  // like UNAVAILABLE, such a call may or may not have reached etcd.
  return error instanceof GRPCUnavailableError || error instanceof GRPCDeadlineExceededError || error instanceof GRPCCancelledError ||
    (error instanceof Error && "isBrokenCircuitError" in error);
}
