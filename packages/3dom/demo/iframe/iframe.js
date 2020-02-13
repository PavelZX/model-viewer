import { ThreeDOMExecutionContext, ThreeDOMExecutionContextMode } from '../../lib/context.js';

// The main page sends a handshake message with the port that will be used
// in the execution context in this iframe. The execution context instantiates
// its own worker but does not instantiate a message channel as the port
// transferred from the main frame will be used for communication.
// This iframe responds to the handshake message passing the 3dom script that
// will be used. The main frame will evaluate the script sending it to the
// worker in this execution context as the communication channel between the
// main frame and the worker in this iframe will already be set.
// This iframe is still able to communicate with the 3dom script using the
// worker inside the execution context.
function messageReceived(e) {
  if (e.data.action === 'handshakeRequest') {
    window.removeEventListener('message', messageReceived);
    const port2 = e.ports[0];
    const executionContext =
        new ThreeDOMExecutionContext(['messaging', 'material-properties'],
            ThreeDOMExecutionContextMode.ExternalPort, port2);

    const script = document.querySelector('script[type="3DOM"]');
    const scriptText = script.textContent;
    e.source.postMessage({action: 'handshakeResponse', payload: scriptText},
        e.origin);
    window.dispatchEvent(
        new CustomEvent('3domready',
            {detail: {executionContext: executionContext}}));
  }
}

window.addEventListener('message', messageReceived);
