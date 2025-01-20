import React, { useState, useEffect } from 'react';
import {
    Box,
    Button,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Paper,
    IconButton,
} from '@mui/material';
import { Edit as EditIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { User, usersApi } from '../services/api';

interface UserFormData {
    username: string;
}

const initialFormData: UserFormData = {
    username: '',
};

export default function UserManagement() {
    const [users, setUsers] = useState<User[]>([]);
    const [open, setOpen] = useState(false);
    const [formData, setFormData] = useState<UserFormData>(initialFormData);
    const [editingId, setEditingId] = useState<number | null>(null);

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        try {
            const data = await usersApi.getAll();
            setUsers(data);
        } catch (error) {
            console.error('Error loading users:', error);
        }
    };

    const handleOpen = (user?: User) => {
        if (user) {
            setFormData({
                username: user.username,
            });
            setEditingId(user.id);
        } else {
            setFormData(initialFormData);
            setEditingId(null);
        }
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
        setFormData(initialFormData);
        setEditingId(null);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            if (editingId) {
                await usersApi.update(editingId, formData);
            } else {
                await usersApi.create(formData);
            }
            handleClose();
            loadUsers();
        } catch (error) {
            console.error('Error saving user:', error);
        }
    };

    const handleDelete = async (id: number) => {
        if (window.confirm('Are you sure you want to delete this user?')) {
            try {
                await usersApi.delete(id);
                loadUsers();
            } catch (error) {
                console.error('Error deleting user:', error);
            }
        }
    };

    return (
        <Box sx={{ p: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                <h1>User Management</h1>
                <Button variant="contained" color="primary" onClick={() => handleOpen()}>
                    Add User
                </Button>
            </Box>

            <TableContainer component={Paper}>
                <Table>
                    <TableHead>
                        <TableRow>
                            <TableCell>Username</TableCell>
                            <TableCell>Joined At</TableCell>
                            <TableCell>Active Conversation</TableCell>
                            <TableCell>Actions</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {users.map((user) => (
                            <TableRow key={user.id}>
                                <TableCell>{user.username}</TableCell>
                                <TableCell>
                                    {new Date(user.joinedAt).toLocaleDateString()}
                                </TableCell>
                                <TableCell>
                                    {user.activeConversationId || 'None'}
                                </TableCell>
                                <TableCell>
                                    <IconButton onClick={() => handleOpen(user)}>
                                        <EditIcon />
                                    </IconButton>
                                    <IconButton onClick={() => handleDelete(user.id)}>
                                        <DeleteIcon />
                                    </IconButton>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>

            <Dialog open={open} onClose={handleClose}>
                <DialogTitle>{editingId ? 'Edit User' : 'Add User'}</DialogTitle>
                <form onSubmit={handleSubmit}>
                    <DialogContent>
                        <TextField
                            autoFocus
                            margin="dense"
                            label="Username"
                            type="text"
                            fullWidth
                            value={formData.username}
                            onChange={(e) =>
                                setFormData({ ...formData, username: e.target.value })
                            }
                            required
                        />
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={handleClose}>Cancel</Button>
                        <Button type="submit" variant="contained" color="primary">
                            {editingId ? 'Save' : 'Add'}
                        </Button>
                    </DialogActions>
                </form>
            </Dialog>
        </Box>
    );
} 