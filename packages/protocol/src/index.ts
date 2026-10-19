import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { InternalHealthServiceHandlers } from "./generated/battleship/internal/v1/InternalHealthService.js";
import type { ProtoGrpcType } from "./generated/internal.js";

const protoPath = fileURLToPath(new URL("./internal.proto", import.meta.url));
const definition = protoLoader.loadSync(protoPath, {
  defaults: true,
  enums: String,
  keepCase: true,
  longs: String,
  oneofs: true
});

const loaded = grpc.loadPackageDefinition(definition) as unknown as ProtoGrpcType;
const healthService = loaded.battleship.internal.v1.InternalHealthService;

export type InternalHealthIdentity = {
  serviceName: string;
  nodeId: string;
  isReady: () => boolean;
};

export async function startInternalGrpcServer(
  port: number,
  identity: InternalHealthIdentity
): Promise<grpc.Server> {
  const server = new grpc.Server();

  const handlers: InternalHealthServiceHandlers = {
    Check: (_call, callback) => {
      callback(null, {
        service: identity.serviceName,
        node_id: identity.nodeId,
        ready: identity.isReady()
      });
    }
  };

  server.addService(healthService.service, handlers);

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });

  return server;
}

export async function checkInternalGrpc(
  address: string,
  deadlineMs = 2_000
): Promise<{ service: string; nodeId: string; ready: boolean }> {
  const client = new healthService(address, grpc.credentials.createInsecure());

  try {
    return await new Promise<{ service: string; nodeId: string; ready: boolean }>((resolve, reject) => {
      client.Check(
        {},
        { deadline: Date.now() + deadlineMs },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          if (!response) {
            reject(new Error("Internal health check returned no response"));
            return;
          }
          resolve({
            service: response.service,
            nodeId: response.node_id,
            ready: response.ready
          });
        }
      );
    });
  } finally {
    client.close();
  }
}
