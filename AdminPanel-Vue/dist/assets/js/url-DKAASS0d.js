var r=new Set(["http:","https:"]);function e(t){if(!t||typeof t!="string")return null;try{const n=new URL(t);return r.has(n.protocol)?n.toString():null}catch{return null}}export{e as t};
