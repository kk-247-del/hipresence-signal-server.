        # Use a full, official Node.js image.
        FROM node:20

        # Set the working directory inside the container.
        WORKDIR /app

        # Copy package.json to ensure npm can find dependencies.
        COPY package.json ./

        # Install production dependencies.
        RUN npm install --production

        # Copy the rest of your app's source code.
        COPY . .

        # Inform Docker that the container listens on port 8080.
        ENV PORT=8080
        EXPOSE $PORT

        # The command to run your application.
        CMD [ "node", "index.js" ]
        
