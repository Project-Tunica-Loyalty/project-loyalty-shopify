import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { NavLink, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import "../styles/loyalty-admin.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <div className="loyalty-app">
        <nav className="loyalty-app-nav" aria-label="Project Loyalty">
          {[
            ["overview", "Overview"],
            ["program", "Program rules"],
            ["customers", "Customers"],
            ["rewards", "Rewards"],
            ["reports", "Reports"],
            ["settings", "Connection settings"],
          ].map(([view, label]) => (
            <NavLink
              key={view}
              to={`/app/loyalty/${view}`}
              className={({ isActive }) =>
                `loyalty-app-nav-link${isActive ? " is-active" : ""}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <Outlet />
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
