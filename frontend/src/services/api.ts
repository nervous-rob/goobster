import axios, { AxiosError } from 'axios';

// API Response Types
export interface Party {
  id: number;
  name: string;
  status: string;
  adventureStatus?: string;
  members: Array<{
    id: number;
    name: string;
    role: string;
    status: string;
  }>;
  currentState?: string;
  plotSummary?: string;
  adventureId?: number;
}

export interface Config {
  imageGeneration: {
    enabled: boolean;
    model: string;
    style: string;
    quality: string;
  };
  adventureSettings: {
    maxPartySize: number;
    turnTimeoutMinutes: number;
    autoEndEnabled: boolean;
  };
  systemPrompts: {
    adventureInit: string;
    sceneGeneration: string;
    decisionMaking: string;
  };
}

export interface User {
    id: number;
    username: string;
    joinedAt: Date;
    activeConversationId: number | null;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

// Create axios instance with default config
export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // If we get HTML instead of JSON, it means the API server isn't responding correctly
    if (error.response?.data instanceof Document || 
        (typeof error.response?.data === 'string' && error.response.data.includes('<!doctype html>'))) {
      throw new Error('API server is not responding correctly. Please check if the backend server is running.');
    }
    throw error;
  }
);

// Helper function to handle API responses
const handleApiResponse = async <T>(apiCall: Promise<any>): Promise<T> => {
  try {
    const response = await apiCall;
    return response.data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('An unexpected error occurred');
  }
};

// Prompts API
export const promptsApi = {
  getAll: () => api.get('/prompts'),
  create: (data: { text: string; label?: string }) => api.post('/prompts', data),
  delete: (id: number) => api.delete(`/prompts/${id}`)
};

// Parties API
export const partiesApi = {
  getAll: () => handleApiResponse<Party[]>(api.get('/parties')),
  getActive: () => handleApiResponse<Party[]>(api.get('/parties/active')),
  getById: (id: number) => handleApiResponse<Party>(api.get(`/parties/${id}`)),
  end: (id: number) => handleApiResponse<void>(api.post(`/parties/${id}/end`)),
  create: (data: { name: string; members: { name: string; role: string }[] }) => 
    handleApiResponse<Party>(api.post('/parties', data))
};

// Config API
export const configApi = {
  get: () => handleApiResponse<Config>(api.get('/config')),
  update: (data: Partial<Config>) => handleApiResponse<Config>(api.put('/config', data))
};

// Image Generation API
export const imageGenApi = {
  generate: (data: { 
    prompt: string; 
    style?: string; 
    model?: string;
    quality?: string;
    size?: string;
  }) => handleApiResponse<{ url: string }>(api.post('/images/generate', data)),
  getAll: () => handleApiResponse<Array<{ id: number; url: string }>>(api.get('/images')),
  delete: (id: number) => handleApiResponse<void>(api.delete(`/images/${id}`)),
  getById: (id: number) => handleApiResponse<{ id: number; url: string }>(api.get(`/images/${id}`))
};

// User Management API calls
export const usersApi = {
    getAll: () => handleApiResponse<User[]>(api.get('/users')),
    getById: (id: number) => handleApiResponse<User>(api.get(`/users/${id}`)),
    create: (data: { username: string }) => handleApiResponse<User>(api.post('/users', data)),
    update: (id: number, data: { username: string; activeConversationId?: number | null }) => 
        handleApiResponse<User>(api.put(`/users/${id}`, data)),
    delete: (id: number) => handleApiResponse<void>(api.delete(`/users/${id}`))
}; 