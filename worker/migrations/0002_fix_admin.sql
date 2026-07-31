-- Update admin password with a bcryptjs-compatible hash
UPDATE users SET password_hash = '$2a$10$qarpxhTSlZDwhn38EEHlj.Q5oQgnvH0Mp9csmSSiaGYri28QyymAi' WHERE email = 'admin@primeprop.ng';
