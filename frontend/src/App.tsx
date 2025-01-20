import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { theme } from './theme';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Prompts from './pages/Prompts';
import Parties from './pages/Parties';
import Config from './pages/Config';
import ImageGen from './pages/ImageGen';
import UserManagement from './pages/UserManagement';

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="prompts" element={<Prompts />} />
            <Route path="parties" element={<Parties />} />
            <Route path="config" element={<Config />} />
            <Route path="image-gen" element={<ImageGen />} />
            <Route path="users" element={<UserManagement />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
