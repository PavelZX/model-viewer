/* @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ThreeDOMCapability} from './api.js';
import {ALLOWLISTED_GLOBALS} from './context/allowlist.js';
import {generateAPI} from './context/generate-api.js';
import {generateCapabilityFilter} from './context/generate-capability-filter.js';
import {generateContextPatch} from './context/generate-context-patch.js';
import {generateInitializer} from './context/generate-initializer.js';
import {ModelGraft as ThreeJSModelGraft} from './facade/three-js/model-graft.js';
import {MutateMessage, ThreeDOMMessageType} from './protocol.js';

const $modelGraft = Symbol('modelGraft');
const $port = Symbol('port');

const $messageEventHandler = Symbol('messageEventHandler');
const $onMessageEvent = Symbol('onMessageEvent');

/**
 * A ModelGraftManipulator is an internal construct intended to consolidate
 * any mutations that operate on the backing scene graph. It can be thought
 * of as a host execution context counterpart to the ModelKernel in the scene
 * graph execution context.
 */
class ModelGraftManipulator {
  protected[$port]: MessagePort;
  protected[$modelGraft]: AnyModelGraft;

  protected[$messageEventHandler] = (event: MessageEvent) =>
      this[$onMessageEvent](event);

  constructor(modelGraft: AnyModelGraft, port: MessagePort) {
    this[$modelGraft] = modelGraft;
    this[$port] = port;
    this[$port].addEventListener('message', this[$messageEventHandler]);
    this[$port].start();
  }

  /**
   * Clean up internal state so that the ModelGraftManipulator can be properly
   * garbage collected.
   */
  dispose() {
    this[$port].removeEventListener('message', this[$messageEventHandler]);
    this[$port].close();
  }

  [$onMessageEvent](event: MessageEvent) {
    const {data} = event;
    if (data && data.type) {
      if (data.type === ThreeDOMMessageType.MUTATE) {
        let applied = false;
        const {mutationId} = data as MutateMessage;
        try {
          this[$modelGraft].mutate(data.id, data.property, data.value);
          applied = true;
        } finally {
          this[$port].postMessage(
              {type: ThreeDOMMessageType.MUTATION_RESULT, applied, mutationId});
        }
      }
    }
  }
}


const ALL_CAPABILITIES: Readonly<Array<ThreeDOMCapability>> =
    Object.freeze(['messaging', 'material-properties', 'fetch']);

// TODO(#1004): Export an abstract interface for ModelGraft someday when we
// want to support multiple rendering backends
export type AnyModelGraft = ThreeJSModelGraft;

/**
 * Constructs and returns a string representing a fully-formed scene graph
 * execution context script, including context patching, capabilities and
 * scene graph API constructs.
 */
export const generateContextScriptSource =
    (capabilities: Readonly<Array<ThreeDOMCapability>> = ALL_CAPABILITIES) => {
      return `;(function() {
var ThreeDOMMessageType = ${JSON.stringify(ThreeDOMMessageType)};

var preservedContext = {
  postMessage: self.postMessage.bind(self),
  addEventListener: self.addEventListener.bind(self),
  importScripts: self.importScripts.bind(self)
};

${generateContextPatch(ALLOWLISTED_GLOBALS)}
${generateAPI()}
${generateCapabilityFilter(capabilities)}
${generateInitializer()}

initialize.call(self, ModelKernel, preservedContext);

})();`;
    };


const $worker = Symbol('worker');
const $workerInitializes = Symbol('workerInitializes');
const $modelGraftManipulator = Symbol('modelGraftManipulator');
const $port2 = Symbol('port2');

export enum ThreeDOMExecutionContextMode {
  // Everything is self contained in the execution context instance: the
  // worker and the communication message channel.
  Standalone,

  // The execution context won't create a worker and will assume that an
  // external worker will be responsible for the execution of the
  // communication. The message channel is created so the ports can be
  // transferred though.
  ExternalWorker,

  // An external port will be passed in the constructor so NO message
  // channel should be created and the passed port will be transfereed to
  // the worker.
  ExternalPort
}

/**
 * A ThreeDOMExecutionContext is created in the host execution context that
 * wishes to invoke scripts in a specially crafted and carefully isolated
 * script context, referred to as the scene graph execution context. For
 * practical implementation purposes, the scene graph execution context is
 * a Worker whose global scope has been heavily patched before any custom
 * script is subsequently invoked in it.
 *
 * The ThreeDOMExecutionContext must be given a set of allowed capabilities
 * when it is created. The allowed capabilities cannot be changed after the
 * scene graph execution context has been established.
 */
export class ThreeDOMExecutionContext extends EventTarget {
  get worker() {
    return this[$worker];
  }

  get port2() {
    return this[$port2];
  }

  protected[$worker]: Worker|null = null;
  protected[$workerInitializes]: Promise<MessagePort|null>;
  protected[$modelGraftManipulator]: ModelGraftManipulator|null = null;
  protected[$port2]: MessagePort|null = null;

  constructor(
      capabilities: Array<ThreeDOMCapability>,
      mode = ThreeDOMExecutionContextMode.Standalone,
      externalPort?: MessagePort) {
    super();

    if (mode !== ThreeDOMExecutionContextMode.ExternalPort && externalPort) {
      throw new Error(`An external port must only be passed in ExternalPort
          mode`);
    }
    if (mode === ThreeDOMExecutionContextMode.ExternalPort && !externalPort) {
      throw new Error(`An external port must be passed in ExternalPort mode`);
    }

    const contextScriptSource = generateContextScriptSource(capabilities);
    const url = URL.createObjectURL(
        new Blob([contextScriptSource], {type: 'text/javascript'}));

    if (mode !== ThreeDOMExecutionContextMode.ExternalWorker) {
      this[$worker] = new Worker(url);
    }

    // Create the MessageChannel if no external port is passed.
    const {port1, port2} =
        externalPort ? {port1: null, port2: null} : new MessageChannel();
    this[$port2] = port2;

    this[$workerInitializes] = new Promise<MessagePort|null>((resolve) => {
      let portForWorker = externalPort;
      if (port1 && port2) {
        const onMessageEvent = (event: MessageEvent) => {
          if (event.data &&
              event.data.type === ThreeDOMMessageType.CONTEXT_INITIALIZED) {
            port1.removeEventListener('message', onMessageEvent);

            resolve(port1);
          }
        };

        port1.addEventListener('message', onMessageEvent);
        port1.start();

        portForWorker = port2;
      }

      // If this execution context is operating in the ExternalWorker mode,
      // the port won't be transferred.
      const worker = this[$worker];
      if (worker && portForWorker) {
        worker.postMessage(
            {type: ThreeDOMMessageType.HANDSHAKE}, [portForWorker]);
      }

      if (externalPort) {
        resolve(null);
      }
    });
  }

  async changeModel(modelGraft: AnyModelGraft|null): Promise<void> {
    const port1 = await this[$workerInitializes];
    if (!port1) {
      return;
    }
    port1.postMessage({
      type: ThreeDOMMessageType.MODEL_CHANGE,
      model: modelGraft != null && modelGraft.model != null ?
          modelGraft.model.toJSON() :
          null
    });

    const modelGraftManipulator = this[$modelGraftManipulator];

    if (modelGraftManipulator != null) {
      modelGraftManipulator.dispose();
      this[$modelGraftManipulator] = null;
    }

    if (modelGraft != null) {
      this[$modelGraftManipulator] =
          new ModelGraftManipulator(modelGraft, port1);
    }
  }

  /**
   * Evaluate an arbitrary chunk of script in the scene graph execution context.
   * The script is guaranteed to be evaluated after the scene graph execution
   * context is fully initialized. It is not guaranteed to be evaluated before
   * or after a Model is made available in the scene graph execution context.
   *
   * Note that web browsers do not universally support module scripts ("ESM") in
   * Workers, so for now all scripts must be valid non-module scripts.
   */
  async eval(scriptSource: string): Promise<void> {
    const port1 = await this[$workerInitializes];
    if (!port1) {
      return;
    }
    const url = URL.createObjectURL(
        new Blob([scriptSource], {type: 'text/javascript'}));
    port1.postMessage({type: ThreeDOMMessageType.IMPORT_SCRIPT, url});
  }

  /**
   * Terminates the scene graph execution context, closes the designated
   * messaging port and generally cleans up the ThreeDOMExecutionContext
   * so that it can be properly garbage collected.
   */
  async terminate() {
    const worker = this[$worker];
    if (worker) {
      worker.terminate();
    }

    const modelGraftManipulator = this[$modelGraftManipulator];

    if (modelGraftManipulator != null) {
      modelGraftManipulator.dispose();
      this[$modelGraftManipulator] = null;
    }

    const port1 = await this[$workerInitializes];
    if (port1) {
      port1.close();
    }
  }
}
