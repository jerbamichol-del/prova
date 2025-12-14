import React from 'react';

export const AppLogoIcon: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = (props) => {
  // Safe access: import.meta.env might be undefined in some environments.
  // Fallback to '/' if BASE_URL is not available.
  const meta = import.meta as any;
  const baseUrl = (meta.env && meta.env.BASE_URL) || '/';
  
  // Ensure we don't double slash if baseUrl is '/' and we append 'logo.png'
  // But usually BASE_URL includes trailing slash or empty string.
  // If fallback is '/', src becomes '/logo.png' which is correct.
  
  return (
    <img
      src={`${baseUrl}logo.png`}
      alt="Gestore Spese Logo"
      {...props}
    />
  );
};