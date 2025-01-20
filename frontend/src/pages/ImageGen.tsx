import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  TextField,
  Typography,
  CircularProgress,
  ImageList,
  ImageListItem,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Alert,
  IconButton,
  Skeleton
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import ReplayIcon from '@mui/icons-material/Replay';
import { imageGenApi } from '../services/api';

interface GeneratedImage {
  id: number;
  url: string;
  prompt: string;
  createdAt: string;
  style: string;
  model: string;
  quality: string;
  size: string;
  isLoading?: boolean;
  error?: string;
}

export default function ImageGen() {
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('vivid');
  const [model, setModel] = useState('dall-e-3');
  const [quality, setQuality] = useState('standard');
  const [size, setSize] = useState('1024x1024');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);

  const handleGenerate = async (retryImage?: GeneratedImage) => {
    const currentPrompt = retryImage?.prompt || prompt;
    if (!currentPrompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    setLoading(true);
    setError(null);

    // If this is a retry, update the loading state for that specific image
    if (retryImage) {
      setImages(prevImages =>
        prevImages.map(img =>
          img.id === retryImage.id ? { ...img, isLoading: true, error: undefined } : img
        )
      );
    }

    try {
      const response = await imageGenApi.generate({
        prompt: currentPrompt,
        style,
        model,
        quality,
        size
      });
      
      if (retryImage) {
        setImages(prevImages =>
          prevImages.map(img =>
            img.id === retryImage.id
              ? {
                  ...img,
                  url: response.url,
                  isLoading: false,
                  error: undefined
                }
              : img
          )
        );
      } else {
        const newImage: GeneratedImage = {
          id: Date.now(),
          url: response.url,
          prompt: currentPrompt,
          createdAt: new Date().toISOString(),
          style,
          model,
          quality,
          size
        };
        setImages([newImage, ...images]);
        setPrompt('');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to generate image';
      if (retryImage) {
        setImages(prevImages =>
          prevImages.map(img =>
            img.id === retryImage.id
              ? { ...img, isLoading: false, error: errorMessage }
              : img
          )
        );
      } else {
        setError(errorMessage);
      }
      console.error('Failed to generate image:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await imageGenApi.delete(id);
      setImages(images.filter(img => img.id !== id));
    } catch (error) {
      console.error('Failed to delete image:', error);
      setError('Failed to delete image');
    }
  };

  const handleDownload = (url: string, prompt: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prompt.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>Image Generation</Typography>

      <Card sx={{ mb: 3, p: 2 }}>
        <TextField
          fullWidth
          multiline
          rows={3}
          label="Image Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          sx={{ mb: 2 }}
        />
        
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <FormControl fullWidth>
            <InputLabel>Style</InputLabel>
            <Select
              value={style}
              label="Style"
              onChange={(e) => setStyle(e.target.value)}
            >
              <MenuItem value="vivid">Vivid</MenuItem>
              <MenuItem value="natural">Natural</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel>Model</InputLabel>
            <Select
              value={model}
              label="Model"
              onChange={(e) => setModel(e.target.value)}
            >
              <MenuItem value="dall-e-3">DALL-E 3</MenuItem>
              <MenuItem value="dall-e-2">DALL-E 2</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel>Quality</InputLabel>
            <Select
              value={quality}
              label="Quality"
              onChange={(e) => setQuality(e.target.value)}
            >
              <MenuItem value="standard">Standard</MenuItem>
              <MenuItem value="hd">HD</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel>Size</InputLabel>
            <Select
              value={size}
              label="Size"
              onChange={(e) => setSize(e.target.value)}
            >
              <MenuItem value="1024x1024">1024x1024</MenuItem>
              <MenuItem value="1792x1024">1792x1024</MenuItem>
              <MenuItem value="1024x1792">1024x1792</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <Button
          variant="contained"
          onClick={() => handleGenerate()}
          disabled={loading || !prompt.trim()}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          Generate Image
        </Button>
      </Card>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ImageList cols={2} gap={16}>
        {images.map((image) => (
          <ImageListItem 
            key={image.id}
            sx={{ 
              bgcolor: 'background.paper',
              borderRadius: 1,
              overflow: 'hidden',
              boxShadow: 1
            }}
          >
            {image.isLoading ? (
              <Skeleton variant="rectangular" width="100%" height={512} />
            ) : (
              <img
                src={image.url}
                alt={image.prompt}
                loading="lazy"
                style={{ width: '100%', height: 'auto' }}
              />
            )}
            <Box
              sx={{
                p: 1,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start'
              }}
            >
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  {image.prompt}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(image.createdAt).toLocaleString()}
                </Typography>
                {image.error && (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {image.error}
                  </Alert>
                )}
              </Box>
              <Box>
                {image.error ? (
                  <IconButton
                    size="small"
                    onClick={() => handleGenerate(image)}
                    disabled={loading}
                  >
                    <ReplayIcon />
                  </IconButton>
                ) : (
                  <>
                    <IconButton
                      size="small"
                      onClick={() => handleDownload(image.url, image.prompt)}
                    >
                      <DownloadIcon />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleDelete(image.id)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </>
                )}
              </Box>
            </Box>
          </ImageListItem>
        ))}
      </ImageList>
    </Box>
  );
} 