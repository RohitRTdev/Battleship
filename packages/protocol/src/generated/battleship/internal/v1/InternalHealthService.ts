// Original file: src/internal.proto

import type * as grpc from '@grpc/grpc-js'
import type { MethodDefinition } from '@grpc/proto-loader'
import type { CheckRequest as _battleship_internal_v1_CheckRequest, CheckRequest__Output as _battleship_internal_v1_CheckRequest__Output } from '../../../battleship/internal/v1/CheckRequest.js';
import type { CheckResponse as _battleship_internal_v1_CheckResponse, CheckResponse__Output as _battleship_internal_v1_CheckResponse__Output } from '../../../battleship/internal/v1/CheckResponse.js';

export interface InternalHealthServiceClient extends grpc.Client {
  Check(argument: _battleship_internal_v1_CheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  Check(argument: _battleship_internal_v1_CheckRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  Check(argument: _battleship_internal_v1_CheckRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  Check(argument: _battleship_internal_v1_CheckRequest, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  check(argument: _battleship_internal_v1_CheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  check(argument: _battleship_internal_v1_CheckRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  check(argument: _battleship_internal_v1_CheckRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  check(argument: _battleship_internal_v1_CheckRequest, callback: grpc.requestCallback<_battleship_internal_v1_CheckResponse__Output>): grpc.ClientUnaryCall;
  
}

export interface InternalHealthServiceHandlers extends grpc.UntypedServiceImplementation {
  Check: grpc.handleUnaryCall<_battleship_internal_v1_CheckRequest__Output, _battleship_internal_v1_CheckResponse>;
  
}

export interface InternalHealthServiceDefinition extends grpc.ServiceDefinition {
  Check: MethodDefinition<_battleship_internal_v1_CheckRequest, _battleship_internal_v1_CheckResponse, _battleship_internal_v1_CheckRequest__Output, _battleship_internal_v1_CheckResponse__Output>
}
