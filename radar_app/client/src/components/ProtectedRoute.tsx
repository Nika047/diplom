import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { Loader } from "@progress/kendo-react-indicators";

import { useAuthContext } from "../context/AuthProvider";

export const ProtectedRoute = ({ children }: { children: ReactNode }) => {
    const { isLoaded, isAuthenticated } = useAuthContext();
    const location = useLocation();

    if (!isLoaded) {
        return <div className="radar-center"><Loader size="large" type="converging-spinner" /></div>;
    }

    if (isAuthenticated) return <>{children}</>;

    // адрес возврата после входа
    const returnPath = location.pathname + location.search;
    if (returnPath && returnPath !== '/login') {
        sessionStorage.setItem('redirectAfterLogin', returnPath);
    }

    return <Navigate to="/login" replace />;
};
