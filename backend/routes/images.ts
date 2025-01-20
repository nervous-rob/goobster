import express from 'express';
import OpenAI from 'openai';

const router = express.Router();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

router.post('/generate', async (req, res) => {
  try {
    const { prompt, style = 'vivid', model = 'dall-e-3', quality = 'standard', size = '1024x1024' } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const response = await openai.images.generate({
      model,
      prompt,
      n: 1,
      quality,
      size,
      style
    });

    res.json({ url: response.data[0].url });
  } catch (error) {
    console.error('Failed to generate image:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate image' });
  }
});

router.get('/', async (req, res) => {
  // TODO: Implement fetching saved images from database
  res.json([]);
});

router.delete('/:id', async (req, res) => {
  // TODO: Implement image deletion from database
  res.sendStatus(200);
});

export default router; 