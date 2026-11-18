import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LocalizationProvider } from "@progress/kendo-react-intl";

import { loadRussianMessages } from "./globalization";

import { AuthProvider } from "./context/AuthProvider";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Layout from "./components/Layout";

import LogIn from "./pages/LogIn";
import RunsPage from "./pages/Runs";
import FlightsPage from "./pages/Flights";
import ModelsPage from "./pages/Models";
import ScenariosPage from "./pages/Scenarios";
import ScenarioFormPage from "./pages/ScenarioForm";
import RunPage, { RunRedirect } from "./pages/RunPage";

const locale = loadRussianMessages();

export default function App() {
    return (
        <LocalizationProvider language={locale}>
            <AuthProvider>
                <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                    <Routes>
                        <Route path="/login" element={<LogIn />} />

                        <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                            <Route path="/" element={<Navigate to="/runs" replace />} />
                            <Route path="/runs" element={<RunPage />} />
                            <Route path="/history" element={<RunsPage />} />
                            <Route path="/flights" element={<FlightsPage />} />
                            <Route path="/models" element={<ModelsPage />} />
                            <Route path="/scenarios" element={<ScenariosPage />} />
                            <Route path="/scenarios/create" element={<ScenarioFormPage />} />
                            <Route path="/scenarios/edit/:oid" element={<ScenarioFormPage />} />
                            <Route path="/runs/:oid" element={<RunPage />} />
                            <Route path="/realtime/:oid" element={<RunRedirect />} />
                            <Route path="/compare/:oid" element={<RunRedirect />} />
                        </Route>

                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </BrowserRouter>
            </AuthProvider>
        </LocalizationProvider>
    );
}
