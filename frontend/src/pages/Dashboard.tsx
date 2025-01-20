import { useState, useEffect } from 'react';
import { Box, Card, CardContent, Grid, Typography } from '@mui/material';
import { configApi, partiesApi } from '../services/api';

interface DashboardStats {
  activeParties: number;
  activeAdventures: number;
  imageGenEnabled: boolean;
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    activeParties: 0,
    activeAdventures: 0,
    imageGenEnabled: false
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [parties, config] = await Promise.all([
          partiesApi.getActive(),
          configApi.get()
        ]);
        
        setStats({
          activeParties: parties.length,
          activeAdventures: parties.filter(p => p.adventureStatus === 'IN_PROGRESS').length,
          imageGenEnabled: config?.imageGeneration?.enabled ?? false
        });
      } catch (error) {
        console.error('Failed to fetch dashboard stats:', error);
      }
    };

    fetchStats();
  }, []);

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Dashboard</Typography>
      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>Active Parties</Typography>
              <Typography variant="h3">{stats.activeParties}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>Active Adventures</Typography>
              <Typography variant="h3">{stats.activeAdventures}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>Image Generation</Typography>
              <Typography variant="h3">{stats.imageGenEnabled ? 'Enabled' : 'Disabled'}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
} 