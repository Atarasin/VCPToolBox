import { events } from './events.js';

class Router {
  constructor() {
    this.routes = [];
    this.currentRoute = null;
    this.defaultRoute = '/stories';
    this.isInitialized = false;
  }

  init() {
    if (this.isInitialized) return;
    
    window.addEventListener('hashchange', this._handleHashChange.bind(this));
    this.isInitialized = true;
    
    this._handleHashChange();
  }

  register(pathPattern, handler) {
    const paramNames = [];
    const regexPattern = pathPattern.replace(/:([^/]+)/g, (_, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    
    this.routes.push({
      pattern: pathPattern,
      regex: new RegExp(`^${regexPattern}$`),
      paramNames,
      handler
    });
  }

  navigate(path) {
    window.location.hash = path;
  }

  _handleHashChange() {
    let hash = window.location.hash.slice(1);
    
    if (!hash || hash === '/') {
      this.navigate(this.defaultRoute);
      return;
    }
    
    const [path] = hash.split('?');
    
    let routeFound = false;
    
    for (const route of this.routes) {
      const match = path.match(route.regex);
      
      if (match) {
        routeFound = true;
        this.currentRoute = path;
        
        const params = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = match[i + 1];
        }
        
        events.emit('route:change', { path, params, pattern: route.pattern });
        route.handler(params);
        break;
      }
    }
    
    if (!routeFound) {
      console.warn(`No route handler found for path: ${path}`);
      this.navigate(this.defaultRoute);
    }
  }
}

export const router = new Router();