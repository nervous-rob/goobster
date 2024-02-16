# Use a base image
FROM node

# Set the working directory
WORKDIR /app

# Copy the application files to the container
COPY . .

# Install dependencies
RUN npm install

# Specify the command to run when the container starts
CMD ["npm", "start"]

