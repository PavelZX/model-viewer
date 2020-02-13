import { ThreeDOMExecutionContext, ThreeDOMExecutionContextMode } from '../../lib/context.js';

// Instantiate a 3dom execution context with no worker. The message
// channel should be ready and accessible to get the port to be sent out
// to the iframe (port2).
const executionContext =
    new ThreeDOMExecutionContext(['messaging', 'material-properties'],
        ThreeDOMExecutionContextMode.ExternalWorker);

// Listenes to messages from the iframe. If the handshake succeeded, the iframe
// will pass the 3dom script to be loaded in the execution context. Once the
// execution context is fully setup, it will be assigned to the model-viewer
// instance.
function messageReceived(e) {
  if (e.data.action === 'handshakeResponse') {
    removeEventListener('message', messageReceived);
    executionContext.eval(e.data.payload);
    mv.setThreeDOMExecutionContext(executionContext);
  }
}

// Send the handshake to the iframe passing the port communication from
// the execution environment.
function sendHandshakeRequest() {
  addEventListener('message', messageReceived);
  iframe.contentWindow.postMessage({action: 'handshakeRequest'}, '*',
      [executionContext.port2]);
}

// Wait for the iframe to be loaded to send the handshake.
function iframeLoaded() {
  iframe.removeEventListener('load', iframeLoaded);
  sendHandshakeRequest();
}
iframe.addEventListener('load', iframeLoaded);
