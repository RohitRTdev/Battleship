import type * as grpc from '@grpc/grpc-js';
import type { MessageTypeDefinition } from '@grpc/proto-loader';

import type { CheckRequest as _battleship_internal_v1_CheckRequest, CheckRequest__Output as _battleship_internal_v1_CheckRequest__Output } from './battleship/internal/v1/CheckRequest.js';
import type { CheckResponse as _battleship_internal_v1_CheckResponse, CheckResponse__Output as _battleship_internal_v1_CheckResponse__Output } from './battleship/internal/v1/CheckResponse.js';
import type { InternalHealthServiceClient as _battleship_internal_v1_InternalHealthServiceClient, InternalHealthServiceDefinition as _battleship_internal_v1_InternalHealthServiceDefinition } from './battleship/internal/v1/InternalHealthService.js';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new(...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  battleship: {
    internal: {
      v1: {
        CheckRequest: MessageTypeDefinition<_battleship_internal_v1_CheckRequest, _battleship_internal_v1_CheckRequest__Output>
        CheckResponse: MessageTypeDefinition<_battleship_internal_v1_CheckResponse, _battleship_internal_v1_CheckResponse__Output>
        InternalHealthService: SubtypeConstructor<typeof grpc.Client, _battleship_internal_v1_InternalHealthServiceClient> & { service: _battleship_internal_v1_InternalHealthServiceDefinition }
      }
    }
  }
}

