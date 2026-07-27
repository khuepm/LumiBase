import { RouterProvider } from 'react-router-dom';
import { router } from './router';

/**
 * Root component for the LumiBase Docs Viewer.
 * Renders the router which handles all page navigation.
 */
export function App() {
  return <RouterProvider router={router} />;
}
