type Listener=(token:string)=>void;
const listeners=new Set<Listener>();

/** Match the rejected token so a late response cannot sign out a newer account. */
export function notifySessionInvalid(token:string) {
  for(const listener of listeners) listener(token);
}
export function onSessionInvalid(listener:Listener) {
  listeners.add(listener);
  return ()=> {listeners.delete(listener);};
}
