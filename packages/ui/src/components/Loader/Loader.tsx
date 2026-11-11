import { Loader as InnateLoader } from "innate-ui";

type InnateLoaderProps = Parameters<typeof InnateLoader>[0];

interface LoaderProps extends InnateLoaderProps {
  class?: InnateLoaderProps["class"];
}

export function Loader(props: LoaderProps) {
  return <InnateLoader {...props} />;
}
export type { LoaderProps };
