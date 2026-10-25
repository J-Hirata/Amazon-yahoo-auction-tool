let request = (...args) => fetch(...args);
export function configureMonitorRequest(handler) {request = handler;}
export function monitorRequest(...args) {return request(...args);}
